export type Region = "global" | "china";
export interface Alias {
  id: string;
  email: string;
  label: string;
  note: string | null;
  active: boolean;
  version: string;
  verifiedAt: string;
  createdAt: string | null;
}
export interface Connection {
  id: string;
  accountEmail: string;
  region: Region;
  status: string;
  lastSync: string | null;
  lastError: string | null;
}
export interface Operation {
  id: string;
  action: string;
  status: string;
  phase: string;
  errorCode: string | null;
  updatedAt: string;
  aliasId: string | null;
}
export interface Snapshot {
  aliases: Alias[];
  connection: Connection | null;
  operations: Operation[];
}
export interface Failure {
  error: {
    code: string;
    message: string;
    requestId: string;
    operationId?: string;
  };
}
