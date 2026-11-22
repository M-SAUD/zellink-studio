export type GlobalRole = "client" | "pm" | "specialist" | "admin" | "super_admin";

export interface Actor {
  id: string;
  email: string;
  displayName: string;
  globalRole: GlobalRole;
  mustChangePassword: boolean;
}

export interface RequestFileScanMessage {
  idempotencyKey: string;
  organizationId: string;
  fileVersionId: string;
  assetType?: "request";
}

export interface OnboardingFileScanMessage {
  idempotencyKey: string;
  organizationId: string;
  onboardingAssetId: string;
  assetType: "onboarding";
}

export type FileScanMessage = RequestFileScanMessage | OnboardingFileScanMessage;

export interface Bindings {
  DB: D1Database;
  FILES: R2Bucket;
  FILE_SCANS: Queue<FileScanMessage>;
  ASSETS: Fetcher;
  APP_MODE: string;
  MAX_UPLOAD_BYTES: string;
  FILE_UPLOADS_ENABLED?: string;
  BOOTSTRAP_SECRET?: string;
  SCANNER?: DurableObjectNamespace;
}

export interface Variables {
  actor?: Actor;
  sessionHash?: string;
  sessionId?: string;
}

export type AppEnv = {
  Bindings: Bindings;
  Variables: Variables;
};

export function isStaffRole(role: GlobalRole): boolean {
  return role === "pm" || role === "specialist" || role === "admin" || role === "super_admin";
}

export function isAdminRole(role: GlobalRole): boolean {
  return role === "admin" || role === "super_admin";
}
