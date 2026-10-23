import { invoke } from '@tauri-apps/api/core'
import { parseSyncCommit, type SyncCommit } from '../core/sync-commit'
import { parseSyncDeviceHead, syncHash } from '../core/sync-contract'
import { encodeWorkspaceIdentity, type WorkspaceIdentity } from '../core/sync-identity'
import { linkSameNamed, previewJoin, type JoinPreview } from '../core/sync-snapshot'
import { bindWorkspace, type SyncBinding } from './sync-native'

interface ProbedHead { deviceId: string; head: number[]; commit: number[] | null }
export interface Credentials { endpoint: string; username: string; password: string }
export interface RemotePreview extends JoinPreview {
  workspaceId: string
  devices: number
  /** Verified remote snapshots, used when the user chooses to link same-named documents. */
  commits: SyncCommit[]
}

/**
 * Read-only preview of joining an existing remote workspace. Every head and commit is parsed
 * through the core trust boundary; a head whose commit is missing or damaged stops the preview.
 */
export async function previewRemote(credentials: Credentials, workspaceId: string, identity: WorkspaceIdentity): Promise<RemotePreview> {
  const heads = await invoke<ProbedHead[]>('sync_probe_workspace', { ...credentials, workspaceId })
  const commits: SyncCommit[] = []
  for (const probed of heads) {
    const head = parseSyncDeviceHead(new Uint8Array(probed.head), workspaceId, probed.deviceId)
    if (!probed.commit) throw new Error('missing_object')
    const bytes = new Uint8Array(probed.commit)
    if ((await syncHash(bytes)) !== head.commitHash) throw new Error('hash_mismatch')
    commits.push(parseSyncCommit(bytes, workspaceId))
  }
  return { ...previewJoin(commits, identity), workspaceId, devices: heads.length, commits }
}

export interface JoinChoice {
  workspaceId: string
  /** Link same-named documents (explicit user choice); null keeps both versions as copies. */
  link: SyncCommit[] | null
}

/**
 * Binds the workspace. Joining an existing remote workspace first writes the remote workspaceId
 * (and, if chosen, linked document ids) into the identity file; if binding then fails, the
 * previous identity is written back.
 */
export async function pairWorkspace(workspace: string, credentials: Credentials, identity: WorkspaceIdentity, identityRevision: string, join: JoinChoice | null): Promise<SyncBinding> {
  const next = join ? (join.link ? linkSameNamed({ ...identity, workspaceId: join.workspaceId }, join.link).identity : { ...identity, workspaceId: join.workspaceId }) : identity
  const bytes = encodeWorkspaceIdentity(next)
  if (bytes.join() === encodeWorkspaceIdentity(identity).join()) return bindWorkspace(workspace, credentials.endpoint, credentials.username, credentials.password)
  const revision = await invoke<string>('sync_identity_write', { id: workspace, expected: identityRevision, bytes: Array.from(bytes) })
  try { return await bindWorkspace(workspace, credentials.endpoint, credentials.username, credentials.password) }
  catch (error) {
    await invoke('sync_identity_write', { id: workspace, expected: revision, bytes: Array.from(encodeWorkspaceIdentity(identity)) }).catch(() => undefined)
    throw error
  }
}
