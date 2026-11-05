export interface ReplicaRecord {
    enabled: boolean;
    label: string;
    baseUri: string;
    settings: unknown;
}
/** Restore only the current project's current folder; never enable a deliberately disabled record. */
export function restoreReplicaRegistration(
    records: Record<string, ReplicaRecord>,
    local: {server: string; project: string; baseUri: string},
    active: {server: string; project: string},
    label: string,
): boolean {
    if (local.server !== active.server || local.project !== active.project) { return false; }
    if (records[local.baseUri]) { return false; }
    if (Object.values(records).some(record => record.baseUri === local.baseUri)) { return false; }
    records[local.baseUri] = {enabled: true, label, baseUri: local.baseUri, settings: {}};
    return true;
}
