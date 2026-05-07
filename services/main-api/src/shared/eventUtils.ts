export const UPLOAD_PERIOD_MONTHS = 12;
export const STORAGE_PERIOD_MONTHS = 24;

export interface EventDates {
  createdAt: Date;
  uploadCloseDate: Date;
  storageExpiryDate: Date;
}

export interface StatusText {
  key: string;
  data?: Record<string, any>;
}

export interface UploadStatus {
  canUpload: boolean;
  isExpired: boolean;
  isManuallyDisabled: boolean;
  daysRemaining: number | null;
  status: 'active' | 'closing_soon' | 'closed';
  statusText: StatusText;
}

export interface StorageStatus {
  isExpired: boolean;
  daysRemaining: number | null;
  status: 'active' | 'expiring_soon' | 'expired';
  statusText: StatusText;
}

export function getEventDates(createdAt: Date | string | null): EventDates {
  let created: Date;
  
  if (createdAt instanceof Date) {
    created = createdAt;
  } else if (typeof createdAt === 'string') {
    const dateStr = createdAt.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(createdAt) 
      ? createdAt 
      : createdAt + 'Z';
    created = new Date(dateStr);
  } else {
    created = new Date();
  }
  
  if (isNaN(created.getTime())) {
    created = new Date();
  }
  
  const uploadCloseDate = new Date(created);
  uploadCloseDate.setMonth(uploadCloseDate.getMonth() + UPLOAD_PERIOD_MONTHS);
  
  const storageExpiryDate = new Date(created);
  storageExpiryDate.setMonth(storageExpiryDate.getMonth() + STORAGE_PERIOD_MONTHS);
  
  return {
    createdAt: created,
    uploadCloseDate,
    storageExpiryDate
  };
}

export function getUploadStatus(
  createdAt: Date | string | null,
  uploadsDisabled: boolean = false
): UploadStatus {
  const now = new Date();
  const dates = getEventDates(createdAt);
  
  const isExpired = now >= dates.uploadCloseDate;
  const daysRemaining = isExpired 
    ? null 
    : Math.ceil((dates.uploadCloseDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  
  const canUpload = !isExpired && !uploadsDisabled;
  
  let status: 'active' | 'closing_soon' | 'closed';
  let statusText: StatusText;
  
  if (isExpired) {
    status = 'closed';
    statusText = { key: 'uploadEnded' };
  } else if (uploadsDisabled) {
    status = 'closed';
    statusText = { key: 'uploadsDisabled' };
  } else if (daysRemaining !== null && daysRemaining <= 30) {
    status = 'closing_soon';
    statusText = formatTimeRemaining(daysRemaining);
  } else {
    status = 'active';
    statusText = formatTimeRemaining(daysRemaining);
  }
  
  return {
    canUpload,
    isExpired,
    isManuallyDisabled: uploadsDisabled,
    daysRemaining,
    status,
    statusText
  };
}

export function getStorageStatus(createdAt: Date | string | null): StorageStatus {
  const now = new Date();
  const dates = getEventDates(createdAt);
  
  const isExpired = now >= dates.storageExpiryDate;
  const daysRemaining = isExpired 
    ? null 
    : Math.ceil((dates.storageExpiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  
  let status: 'active' | 'expiring_soon' | 'expired';
  let statusText: StatusText;
  
  if (isExpired) {
    status = 'expired';
    statusText = { key: 'storageEnded' };
  } else if (daysRemaining !== null && daysRemaining <= 30) {
    status = 'expiring_soon';
    statusText = formatTimeRemaining(daysRemaining);
  } else {
    status = 'active';
    statusText = formatTimeRemaining(daysRemaining);
  }
  
  return {
    isExpired,
    daysRemaining,
    status,
    statusText
  };
}

function formatTimeRemaining(days: number | null): StatusText {
  if (days === null) return { key: '' };
  
  if (days <= 0) return { key: 'today' };
  if (days === 1) return { key: 'daysLeft', data: { count: 1 } };
  if (days < 30) return { key: 'daysLeft', data: { count: days } };
  
  const months = Math.floor(days / 30);
  if (months === 1) return { key: 'monthsLeft', data: { count: 1 } };
  if (months < 12) return { key: 'monthsLeft', data: { count: months } };
  
  const years = Math.floor(months / 12);
  const remainingMonths = months % 12;
  
  if (remainingMonths === 0) {
    return { key: 'yearsLeft', data: { count: years } };
  }
  
  return { key: 'yearsMonthsLeft', data: { years, months: remainingMonths } };
}
