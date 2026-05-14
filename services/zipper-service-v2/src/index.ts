import express from 'express';
import crypto from 'node:crypto';
import { CloudTasksClient } from '@google-cloud/tasks';
import { JobsClient, ExecutionsClient } from '@google-cloud/run';
import { Storage } from '@google-cloud/storage';
import { config } from './config.js';
import { buildZip, generateZipName, type ZipResult } from './zipper.js';
import { sendWebhook } from './webhook.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

const tasksClient = new CloudTasksClient();
const jobsClient = new JobsClient();
const executionsClient = new ExecutionsClient();
const storage = new Storage();

type ZipRequestBody = {
  mediaIds: string[];
  eventName: string;
  eventId: string;
  userEmail: string;
};

type ProcessZipBody = ZipRequestBody & {
  jobId: string;
  zipFileName: string;
};

// Body for /start-job — minimalt, peker bare på en GCS-fil med full payload.
type StartJobBody = {
  jobId: string;
  payloadObj: string;
};

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// Public-fasade: main-api (på vegne av frontend-en) POSTer hit. Cloud Run
// validerer OIDC automatisk via --no-allow-unauthenticated. Caller må sende
// Authorization: Bearer <id_token> med audience = denne service-URL-en.
//
// Routing avhengig av config.zipBackend:
//   'tasks' → Cloud Tasks dispatcher /process-zip i samme container
//   'jobs'  → Cloud Tasks dispatcher /start-job som invoker en Cloud Run Job
app.post('/zip', async (req, res) => {
  const { mediaIds, eventName, eventId, userEmail } = req.body as ZipRequestBody;

  if (!Array.isArray(mediaIds) || mediaIds.length === 0) {
    return res.status(400).json({ error: 'mediaIds[] is required' });
  }
  if (!eventName || !eventId || !userEmail) {
    return res.status(400).json({ error: 'eventName, eventId, userEmail required' });
  }

  const jobId = crypto.randomBytes(16).toString('hex');
  const zipFileName = generateZipName(eventName, eventId);
  const queuePath = tasksClient.queuePath(config.projectId, config.queueLocation, config.queueName);

  try {
    if (config.zipBackend === 'jobs') {
      if (!config.jobName) {
        throw new Error('ZIP_BACKEND=jobs men JOB_NAME er ikke satt');
      }
      // Skriv full payload til GCS — Cloud Tasks body har 100 KB-limit som
      // er for lite for store mediaIds-lister (15k filer × ~80 chars = >1 MB).
      // Job-en leser denne fila ved oppstart.
      const payloadObj = `payloads/${jobId}.json`;
      const fullPayload: ProcessZipBody = { jobId, mediaIds, eventName, eventId, userEmail, zipFileName };
      await storage.bucket(config.bucket).file(payloadObj).save(JSON.stringify(fullPayload), {
        contentType: 'application/json',
        resumable: false,
      });

      // Cloud Tasks dispatcher /start-job med liten body (peker på GCS-payload).
      // dispatchDeadline=60s — /start-job skal returnere raskt (kun runJob-call).
      const startJobBody: StartJobBody = { jobId, payloadObj };
      const [response] = await tasksClient.createTask({
        parent: queuePath,
        task: {
          dispatchDeadline: { seconds: 60 },
          httpRequest: {
            httpMethod: 'POST',
            url: `${config.serviceUrl}/start-job`,
            headers: { 'Content-Type': 'application/json' },
            body: Buffer.from(JSON.stringify(startJobBody)).toString('base64'),
            oidcToken: {
              serviceAccountEmail: config.workerServiceAccount,
              audience: config.serviceUrl,
            },
          },
        },
      });

      console.log(JSON.stringify({
        msg: 'queued-jobs', jobId, taskName: response.name,
        fileCount: mediaIds.length, payloadObj,
      }));

      return res.status(202).json({
        success: true,
        jobId,
        expectedFileName: zipFileName,
        estimatedFiles: mediaIds.length,
      });
    }

    // ===== Legacy tasks-mode (default) =====
    // Cloud Tasks default dispatchDeadline = 10 min. Store ZIPs (50+ filer
    // / flere GB) overstiger lett dette og trigger retry-loop. Vi bruker
    // 30 min som er max-grensen for Cloud Tasks. ZIPs som overstiger
    // 30 min trenger ZIP_BACKEND=jobs.
    const taskBody: ProcessZipBody = { jobId, mediaIds, eventName, eventId, userEmail, zipFileName };
    const [response] = await tasksClient.createTask({
      parent: queuePath,
      task: {
        dispatchDeadline: { seconds: 1800 },
        httpRequest: {
          httpMethod: 'POST',
          url: `${config.serviceUrl}/process-zip`,
          headers: { 'Content-Type': 'application/json' },
          body: Buffer.from(JSON.stringify(taskBody)).toString('base64'),
          oidcToken: {
            serviceAccountEmail: config.workerServiceAccount,
            audience: config.serviceUrl,
          },
        },
      },
    });

    console.log(JSON.stringify({ msg: 'queued', jobId, taskName: response.name, fileCount: mediaIds.length }));

    return res.status(202).json({
      success: true,
      jobId,
      expectedFileName: zipFileName,
      estimatedFiles: mediaIds.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ msg: 'queue-failed', jobId, error: message }));
    return res.status(500).json({ error: 'Failed to queue ZIP job', details: message });
  }
});

// Worker-endpoint for tasks-mode — kun callable av Cloud Tasks (med OIDC fra
// workerServiceAccount). Cloud Run validerer at audience matcher service-URL-en
// og signer-SA er gyldig.
app.post('/process-zip', async (req, res) => {
  const body = req.body as ProcessZipBody;
  const { jobId, mediaIds, eventName, eventId, userEmail, zipFileName } = body;

  console.log(JSON.stringify({ msg: 'start', jobId, eventId, fileCount: mediaIds.length, userEmail }));

  let result: ZipResult;
  try {
    result = await buildZip(jobId, mediaIds, eventId, eventName, zipFileName);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ msg: 'failed', jobId, eventId, error: message }));
    await sendWebhook('zip.failed', { jobId, eventId, eventName, userEmail, error: message }).catch(() => {});
    return res.status(500).json({ error: 'ZIP processing failed', details: message, jobId });
  }

  console.log(
    JSON.stringify({
      msg: 'completed',
      jobId,
      eventId,
      sizeMB: Math.round((result.sizeBytes / 1024 / 1024) * 10) / 10,
      fileCount: result.fileCount,
      skipped: result.skipped,
      processingTimeMs: result.processingTimeMs,
    }),
  );

  await sendWebhook('zip.completed', {
    jobId, eventId, eventName, userEmail,
    status: 'completed',
    zipUrl: result.signedUrl,
    zipPath: result.zipPath,
    zipFileName,
    fileCount: result.fileCount,
    skippedCount: result.skipped,
    sizeMB: Math.round((result.sizeBytes / 1024 / 1024) * 10) / 10,
    processingTimeSeconds: Math.round(result.processingTimeMs / 1000),
    outputBackend: result.outputBackend,
    errors: result.errors.length > 0 ? result.errors.slice(0, 10) : undefined,
  }).catch((e) => console.warn('webhook failed:', e));

  return res.json({
    success: true,
    jobId,
    processed: result.fileCount,
    skipped: result.skipped,
    sizeMB: Math.round((result.sizeBytes / 1024 / 1024) * 10) / 10,
    zipUrl: result.signedUrl,
    errors: result.errors.length > 0 ? result.errors.slice(0, 5) : undefined,
  });
});

// Worker-endpoint for jobs-mode — Cloud Tasks-dispatch sender hit, vi sjekker
// hvor mange Cloud Run Job-executions som kjører nå, og enten:
//   (a) kicker av en ny execution (under grensen)
//   (b) returnerer 503 (Cloud Tasks retry-er med backoff = naturlig venting)
//
// Endpointet er bevisst rask — kun en runJob-call. Selve ZIP-arbeidet skjer
// i Job-containeren (job.ts) som kjører helt uavhengig.
app.post('/start-job', async (req, res) => {
  const { jobId, payloadObj } = req.body as StartJobBody;
  if (!jobId || !payloadObj) {
    return res.status(400).json({ error: 'jobId og payloadObj required' });
  }

  const jobName = `projects/${config.projectId}/locations/${config.jobLocation}/jobs/${config.jobName}`;

  try {
    // Throttle: hvor mange aktive (running/pending) executions har Job-en nå?
    // listExecutions returnerer alle executions; vi filtrerer på de som ikke
    // er ferdige (completionTime mangler).
    const [executions] = await executionsClient.listExecutions({ parent: jobName });
    const active = executions.filter((e) => !e.completionTime).length;

    if (active >= config.maxConcurrentJobExecutions) {
      console.warn(JSON.stringify({
        msg: 'throttled', jobId, active,
        max: config.maxConcurrentJobExecutions,
      }));
      // 503 → Cloud Tasks retry-er med backoff. Brukerens ZIP starter når
      // det blir ledig kapasitet, ingenting går tapt.
      res.set('Retry-After', '60');
      return res.status(503).json({
        error: 'Too many concurrent ZIP jobs',
        active,
        max: config.maxConcurrentJobExecutions,
      });
    }

    // runJob returnerer [LROperation, request, response]. LRO-en har .name som
    // peker på den startende execution-en. Vi awaiter ikke completion — Job
    // kjører uavhengig, vi returnerer 200 til Cloud Tasks så snart Job er invoked.
    const [operation] = await jobsClient.runJob({
      name: jobName,
      overrides: {
        containerOverrides: [
          {
            env: [
              { name: 'JOB_PAYLOAD_OBJECT', value: payloadObj },
              { name: 'JOB_MODE', value: 'true' },
            ],
          },
        ],
      },
    });

    const operationName = operation.name ?? '(unknown)';
    console.log(JSON.stringify({
      msg: 'job-invoked', jobId,
      operationName,
      activeBeforeStart: active,
    }));

    return res.status(200).json({ success: true, jobId, operationName });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ msg: 'start-job-failed', jobId, error: message }));
    // 500 → Cloud Tasks retry-er. Hvis det er en permanent feil (f.eks. JOB_NAME
    // peker på ikke-eksisterende Job) vil retries til slutt feile etter max-attempts.
    return res.status(500).json({ error: 'Failed to start ZIP job', details: message, jobId });
  }
});

const server = app.listen(config.port, () => {
  console.log(JSON.stringify({
    msg: 'started',
    port: config.port,
    bucket: config.bucket,
    queue: `${config.queueLocation}/${config.queueName}`,
    serviceUrl: config.serviceUrl,
    searchPaths: config.searchPathTemplates,
    zipBackend: config.zipBackend,
    zipOutput: config.zipOutput,
    r2Bucket: config.r2.bucket || null,
    jobName: config.jobName,
    maxConcurrentJobs: config.maxConcurrentJobExecutions,
  }));
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
