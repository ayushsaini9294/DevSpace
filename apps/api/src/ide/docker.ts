import Docker from 'dockerode';
import { env } from '../config/env.ts';

/**
 * IDE containers through dockerode, on Docker's local socket only (never TCP). Every setting
 * here comes from the Phase 5 design (docs/decisions.md); tests inspect the real container.
 */

export const docker = new Docker({ socketPath: env.DOCKER_SOCKET });

/** The port OpenVSCode Server listens on inside the image. */
export const CONTAINER_PORT = 3000;
/** Where the copy is mounted and the folder the IDE opens. */
export const WORKSPACE_PATH = '/home/workspace';

export const NANO_CPUS = 1_000_000_000; // 1 CPU
export const MEMORY_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
export const PIDS_LIMIT = 512;

export function containerName(copyId: string): string {
  return `devspace-ide-${copyId}`;
}

/** The path the IDE is served under, with no trailing slash (the image's DEVSPACE_BASE_PATH). */
export function ideBasePath(copyId: string): string {
  return `/ide/${copyId}`;
}

/** The API process's own uid:gid, so files the IDE writes in the copy stay ours. */
export function apiUser(): string {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) {
    throw new Error('IDE containers need a POSIX host (run the API inside WSL or Linux)');
  }
  return `${uid}:${gid}`;
}

export interface IdeContainerInput {
  copyId: string;
  projectId: string;
  /** The copy's folder on the Docker host. */
  hostDir: string;
  token: string;
  /** The copy's AI gateway token (Phase 12); only its hash is stored in the database. */
  aiToken: string;
}

/** Where the container's AI assistant sends requests: the AI gateway on the IDE network. */
export function aiGatewayBaseUrl(): string {
  return `http://${env.AI_GATEWAY_HOST}:${env.AI_GATEWAY_PORT}/v1`;
}

/** The assistant's default model: the first default free model (AI_DEFAULT_MODELS). */
export function aiAssistantDefaultModel(): string {
  return env.AI_DEFAULT_MODELS[0]!;
}

/** The full create options for one copy's IDE container. */
export function ideContainerSpec(input: IdeContainerInput): Docker.ContainerCreateOptions {
  return {
    name: containerName(input.copyId),
    Image: env.IDE_IMAGE,
    User: apiUser(),
    Env: [
      `DEVSPACE_CONNECTION_TOKEN=${input.token}`,
      `DEVSPACE_BASE_PATH=${ideBasePath(input.copyId)}`,
      // The assistant's settings (start.sh writes them into its config, then unsets them). The
      // member's real OpenRouter key is never here: the gateway adds it on the server.
      `DEVSPACE_AI_TOKEN=${input.aiToken}`,
      `DEVSPACE_AI_BASE_URL=${aiGatewayBaseUrl()}`,
      `DEVSPACE_AI_MODEL=${aiAssistantDefaultModel()}`,
    ],
    Labels: { 'devspace.copy': input.copyId, 'devspace.project': input.projectId },
    WorkingDir: WORKSPACE_PATH,
    HostConfig: {
      // The copy's folder is the only mount: no Docker socket, no volumes, no other binds.
      Mounts: [{ Type: 'bind', Source: input.hostDir, Target: WORKSPACE_PATH, ReadOnly: false }],
      Binds: [],
      NetworkMode: env.IDE_NETWORK,
      // No published ports: the API reaches the container at its IP on the IDE network.
      PortBindings: {},
      PublishAllPorts: false,
      NanoCpus: NANO_CPUS,
      Memory: MEMORY_BYTES,
      // Equal to Memory: no swap on top of the 2 GB.
      MemorySwap: MEMORY_BYTES,
      PidsLimit: PIDS_LIMIT,
      SecurityOpt: ['no-new-privileges'],
      CapDrop: ['ALL'],
      Privileged: false,
      RestartPolicy: { Name: 'no' },
      // Bounded logs, so a noisy IDE can't fill the host's disk.
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '2' } },
    },
    NetworkingConfig: { EndpointsConfig: { [env.IDE_NETWORK]: {} } },
  };
}

/** True when Docker says the object (container, image, network) doesn't exist. */
export function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'statusCode' in err && err.statusCode === 404;
}

/** True when Docker refused because the name is taken (another start won the race). */
export function isConflict(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'statusCode' in err && err.statusCode === 409;
}

/** Inspects the copy's container by name; null if there is none. */
export async function inspectIdeContainer(
  copyId: string,
): Promise<Docker.ContainerInspectInfo | null> {
  try {
    return await docker.getContainer(containerName(copyId)).inspect();
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** The value of `name` in a container's environment, if set. */
export function envValue(info: Docker.ContainerInspectInfo, name: string): string | undefined {
  const prefix = `${name}=`;
  return info.Config.Env?.find((e) => e.startsWith(prefix))?.slice(prefix.length);
}

/** The container's address on the IDE network, if it is attached and has one. */
export function ideNetworkIp(info: Docker.ContainerInspectInfo): string | undefined {
  const ip = info.NetworkSettings.Networks?.[env.IDE_NETWORK]?.IPAddress;
  return ip ? ip : undefined;
}

/**
 * True when an existing container was made from today's settings for this copy (same image,
 * user, labels, the one mount, the one network). Anything else is removed and made again.
 */
export function matchesSpec(
  info: Docker.ContainerInspectInfo,
  input: Omit<IdeContainerInput, 'token' | 'aiToken'>,
): boolean {
  const mounts = info.Mounts ?? [];
  const networks = Object.keys(info.NetworkSettings.Networks ?? {});
  const labels = info.Config.Labels ?? {};
  return (
    info.Config.Image === env.IDE_IMAGE &&
    info.Config.User === apiUser() &&
    labels['devspace.copy'] === input.copyId &&
    labels['devspace.project'] === input.projectId &&
    mounts.length === 1 &&
    mounts[0]!.Source === input.hostDir &&
    mounts[0]!.Destination === WORKSPACE_PATH &&
    networks.length === 1 &&
    networks[0] === env.IDE_NETWORK &&
    envValue(info, 'DEVSPACE_BASE_PATH') === ideBasePath(input.copyId) &&
    !!envValue(info, 'DEVSPACE_CONNECTION_TOKEN') &&
    !!envValue(info, 'DEVSPACE_AI_TOKEN') &&
    envValue(info, 'DEVSPACE_AI_BASE_URL') === aiGatewayBaseUrl()
  );
}

/** The last lines the container printed (for a failed start's logged reason). */
export async function containerLogTail(copyId: string, lines = 20): Promise<string> {
  try {
    const out = await docker
      .getContainer(containerName(copyId))
      .logs({ stdout: true, stderr: true, tail: lines, follow: false });
    // Non-TTY logs are multiplexed: 8-byte frame headers before each chunk.
    const buf = Buffer.isBuffer(out) ? out : Buffer.from(String(out));
    const parts: string[] = [];
    let i = 0;
    while (i + 8 <= buf.length) {
      const size = buf.readUInt32BE(i + 4);
      parts.push(buf.subarray(i + 8, i + 8 + size).toString('utf8'));
      i += 8 + size;
    }
    return (parts.length ? parts.join('') : buf.toString('utf8')).trim();
  } catch {
    return '';
  }
}

/** Force-removes containers by label filter, e.g. `devspace.project=<id>`. Errors are logged. */
export async function removeContainersByLabel(label: string): Promise<void> {
  try {
    const list = await docker.listContainers({ all: true, filters: { label: [label] } });
    await Promise.all(
      list.map((c) =>
        docker
          .getContainer(c.Id)
          .remove({ force: true })
          .catch((err: unknown) => {
            if (!isNotFound(err)) throw err;
          }),
      ),
    );
  } catch (err) {
    console.error(
      `Could not remove IDE containers (${label}):`,
      err instanceof Error ? err.message : err,
    );
  }
}
