/**
 * CursorAdapterLive — Cursor SDK local agents.
 *
 * @module CursorAdapterLive
 */
import * as nodePath from "node:path";

import {
  ApprovalRequestId,
  type CursorSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  type RuntimeContentStreamKind,
  type ThreadId,
  type ToolLifecycleItemType,
  TurnId,
} from "@t3tools/contracts";
import {
  Agent,
  type AgentOptions,
  type ModelSelection as CursorSdkModelSelection,
  type Run,
  type SDKAgent,
  type SDKMessage,
  type SDKUserMessage,
  type ToolUseBlock,
} from "@cursor/sdk";
import { Effect, FileSystem, Queue, Random, Ref, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type CursorAdapterShape } from "../Services/CursorAdapter.ts";
import { DEFAULT_CURSOR_SDK_MODEL, resolveCursorAcpBaseModelId } from "./CursorProvider.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("cursor");
const CURSOR_SDK_RESUME_VERSION = 2 as const;

export interface CursorAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: typeof ProviderInstanceId.Type;
  readonly resolveSettings?: Effect.Effect<CursorSettings>;
}

interface CursorSdkResumeCursor {
  readonly schemaVersion: typeof CURSOR_SDK_RESUME_VERSION;
  readonly agentId: string;
  readonly runtime?: "local" | "cloud" | undefined;
}

interface CursorTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

interface CursorSessionContext {
  session: ProviderSession;
  readonly agent: SDKAgent;
  readonly cwd: string;
  readonly turns: Array<CursorTurnSnapshot>;
  readonly stopped: Ref.Ref<boolean>;
  activeRun: Run | undefined;
  activeTurnId: TurnId | undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCursorSdkResume(raw: unknown): CursorSdkResumeCursor | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== CURSOR_SDK_RESUME_VERSION) return undefined;
  if (typeof raw.agentId !== "string" || !raw.agentId.trim()) return undefined;
  const runtime = raw.runtime === "cloud" || raw.runtime === "local" ? raw.runtime : undefined;
  return {
    schemaVersion: CURSOR_SDK_RESUME_VERSION,
    agentId: raw.agentId.trim(),
    ...(runtime ? { runtime } : {}),
  };
}

function requireApiKey(settings: CursorSettings, operation: string): string {
  const apiKey = settings.apiKey.trim();
  if (!apiKey) {
    throw new ProviderAdapterValidationError({
      provider: PROVIDER,
      operation,
      issue: "Cursor SDK API key is required. Add one in Settings > Providers > Cursor.",
    });
  }
  return apiKey;
}

function resolveCursorSdkRuntime(
  settings: CursorSettings,
  resume: CursorSdkResumeCursor | undefined,
): "local" | "cloud" {
  return resume?.runtime ?? (settings.cloudEnabled ? "cloud" : "local");
}

function buildCursorSdkAgentOptions(input: {
  readonly settings: CursorSettings;
  readonly apiKey: string;
  readonly model: CursorSdkModelSelection;
  readonly cwd: string;
  readonly operation: string;
  readonly runtime: "local" | "cloud";
}): AgentOptions {
  if (input.runtime === "local") {
    return {
      apiKey: input.apiKey,
      model: input.model,
      local: { cwd: input.cwd },
    };
  }

  const repositoryUrl = input.settings.cloudRepositoryUrl.trim();
  if (!repositoryUrl) {
    throw new ProviderAdapterValidationError({
      provider: PROVIDER,
      operation: input.operation,
      issue: "Cursor Cloud agents require a repository URL in Settings > Providers > Cursor.",
    });
  }

  const startingRef = input.settings.cloudStartingRef.trim();
  return {
    apiKey: input.apiKey,
    model: input.model,
    cloud: {
      repos: [
        {
          url: repositoryUrl,
          ...(startingRef ? { startingRef } : {}),
        },
      ],
      autoCreatePR: input.settings.cloudAutoCreatePr,
    },
  };
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

const buildEventBase = (input: {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly raw?: unknown;
}): Effect.Effect<
  Pick<
    ProviderRuntimeEvent,
    "eventId" | "provider" | "threadId" | "createdAt" | "turnId" | "itemId" | "raw"
  >
> =>
  Random.nextUUIDv4.pipe(
    Effect.map((uuid) => ({
      eventId: EventId.make(uuid),
      provider: PROVIDER,
      threadId: input.threadId,
      createdAt: nowIso(),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
      ...(input.raw !== undefined
        ? {
            raw: {
              source: "cursor.sdk.event",
              payload: input.raw,
            },
          }
        : {}),
    })),
  );

function resolveTurnSnapshot(context: CursorSessionContext, turnId: TurnId): CursorTurnSnapshot {
  const existing = context.turns.find((turn) => turn.id === turnId);
  if (existing) return existing;
  const created: CursorTurnSnapshot = { id: turnId, items: [] };
  context.turns.push(created);
  return created;
}

function appendTurnItem(
  context: CursorSessionContext,
  turnId: TurnId | undefined,
  item: unknown,
): void {
  if (!turnId) return;
  resolveTurnSnapshot(context, turnId).items.push(item);
}

function sdkToolItemType(name: string): ToolLifecycleItemType {
  const normalized = name.toLowerCase();
  if (normalized.includes("shell") || normalized.includes("bash") || normalized.includes("cmd")) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("delete")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("web") || normalized.includes("grep") || normalized.includes("search")) {
    return "web_search";
  }
  return "dynamic_tool_call";
}

function cursorSdkModelSelection(
  model: string | null | undefined,
  options:
    | ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>
    | null
    | undefined,
): CursorSdkModelSelection {
  return {
    id: resolveCursorAcpBaseModelId(model) || DEFAULT_CURSOR_SDK_MODEL,
    ...(options && options.length > 0
      ? {
          params: options.map((option) => ({
            id: option.id,
            value: String(option.value),
          })),
        }
      : {}),
  };
}

function appendToolUseBlocks(
  context: CursorSessionContext,
  turnId: TurnId,
  blocks: ReadonlyArray<ToolUseBlock>,
): void {
  for (const block of blocks) {
    appendTurnItem(context, turnId, {
      type: "tool_use",
      id: block.id,
      name: block.name,
      input: block.input,
    });
  }
}

export function makeCursorAdapter(
  cursorSettings: CursorSettings,
  options?: CursorAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("cursor");
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* Effect.service(ServerConfig);
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

    const sessions = new Map<ThreadId, CursorSessionContext>();
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);

    const getEffectiveSettings = options?.resolveSettings ?? Effect.succeed(cursorSettings);

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = nowIso();
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: crypto.randomUUID(),
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<
      CursorSessionContext,
      ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError
    > =>
      Effect.gen(function* () {
        const context = sessions.get(threadId);
        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
        }
        if (yield* Ref.get(context.stopped)) {
          return yield* new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId });
        }
        return context;
      });

    const stopContext = (threadId: ThreadId, context: CursorSessionContext) =>
      Effect.gen(function* () {
        const alreadyStopped = yield* Ref.getAndSet(context.stopped, true);
        if (alreadyStopped) return;
        if (context.activeRun && context.activeRun.status === "running") {
          yield* Effect.tryPromise(() => context.activeRun!.cancel()).pipe(Effect.ignore);
        }
        yield* Effect.sync(() => context.agent.close()).pipe(Effect.ignore);
        sessions.delete(threadId);
        yield* emit({
          ...(yield* buildEventBase({ threadId })),
          type: "session.exited",
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: CursorAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "cwd is required and must be non-empty.",
          });
        }

        const existing = sessions.get(input.threadId);
        if (existing) {
          yield* stopContext(input.threadId, existing);
        }

        const cwd = nodePath.resolve(input.cwd.trim());
        const settings = yield* getEffectiveSettings;
        const apiKey = requireApiKey(settings, "startSession");
        const selected =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        const model = cursorSdkModelSelection(selected?.model, selected?.options);
        const resume = parseCursorSdkResume(input.resumeCursor);
        const runtime = resolveCursorSdkRuntime(settings, resume);
        const agentOptions = buildCursorSdkAgentOptions({
          settings,
          apiKey,
          model,
          cwd,
          operation: "startSession",
          runtime,
        });

        const agent = yield* Effect.tryPromise({
          try: () =>
            resume ? Agent.resume(resume.agentId, agentOptions) : Agent.create(agentOptions),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: errorDetail(cause),
              cause,
            }),
        });

        const now = nowIso();
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd,
          model: model.id,
          threadId: input.threadId,
          resumeCursor: {
            schemaVersion: CURSOR_SDK_RESUME_VERSION,
            agentId: agent.agentId,
            runtime,
          },
          createdAt: now,
          updatedAt: now,
        };

        const context: CursorSessionContext = {
          session,
          agent,
          cwd,
          turns: [],
          stopped: yield* Ref.make(false),
          activeRun: undefined,
          activeTurnId: undefined,
        };
        sessions.set(input.threadId, context);

        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "session.started",
          payload: { resume: { agentId: agent.agentId, resumed: Boolean(resume), runtime } },
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "session.state.changed",
          payload: { state: "ready", reason: "Cursor SDK session ready" },
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "thread.started",
          payload: { providerThreadId: agent.agentId },
        });

        return session;
      });

    const emitSdkMessage = (
      context: CursorSessionContext,
      turnId: TurnId,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* logNative(context.session.threadId, `sdk.${message.type}`, message);
        switch (message.type) {
          case "assistant": {
            const textBlocks = message.message.content.filter((block) => block.type === "text");
            const toolBlocks = message.message.content.filter(
              (block): block is ToolUseBlock => block.type === "tool_use",
            );
            for (const block of textBlocks) {
              if (!block.text) continue;
              appendTurnItem(context, turnId, block);
              yield* emit({
                ...(yield* buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  raw: message,
                })),
                type: "content.delta",
                payload: { streamKind: "assistant_text", delta: block.text },
              });
            }
            appendToolUseBlocks(context, turnId, toolBlocks);
            for (const block of toolBlocks) {
              yield* emit({
                ...(yield* buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  itemId: block.id,
                  raw: message,
                })),
                type: "item.started",
                payload: {
                  itemType: sdkToolItemType(block.name),
                  status: "inProgress",
                  title: block.name,
                  data: block.input,
                },
              });
            }
            return;
          }
          case "thinking":
            if (!message.text) return;
            appendTurnItem(context, turnId, message);
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                raw: message,
              })),
              type: "content.delta",
              payload: {
                streamKind: "reasoning_text" satisfies RuntimeContentStreamKind,
                delta: message.text,
              },
            });
            return;
          case "tool_call": {
            const itemType = sdkToolItemType(message.name);
            appendTurnItem(context, turnId, message);
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: message.call_id,
                raw: message,
              })),
              type: message.status === "running" ? "item.updated" : "item.completed",
              payload: {
                itemType,
                status:
                  message.status === "running"
                    ? "inProgress"
                    : message.status === "error"
                      ? "failed"
                      : "completed",
                title: message.name,
                data: {
                  args: message.args,
                  result: message.result,
                  truncated: message.truncated,
                },
              },
            });
            return;
          }
          case "status":
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                raw: message,
              })),
              type: "session.state.changed",
              payload: {
                state:
                  message.status === "RUNNING"
                    ? "running"
                    : message.status === "ERROR"
                      ? "error"
                      : message.status === "FINISHED" || message.status === "CANCELLED"
                        ? "ready"
                        : "starting",
                ...(message.message ? { reason: message.message } : {}),
              },
            });
            return;
          case "task":
            if (!message.text) return;
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                raw: message,
              })),
              type: "tool.summary",
              payload: { summary: message.text },
            });
            return;
          case "system":
          case "user":
          case "request":
            appendTurnItem(context, turnId, message);
            return;
        }
      });

    const sendTurn: CursorAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        const settings = yield* getEffectiveSettings;
        requireApiKey(settings, "sendTurn");
        const turnId = TurnId.make(crypto.randomUUID());
        const selected =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        const model = cursorSdkModelSelection(
          selected?.model ?? context.session.model,
          selected?.options,
        );

        const text = input.input?.trim() ?? "";
        const images: SDKUserMessage["images"] = [];
        if (input.attachments && input.attachments.length > 0) {
          for (const attachment of input.attachments) {
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "agent.send",
                detail: `Invalid attachment id '${attachment.id}'.`,
              });
            }
            const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "agent.send",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
            images.push({
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            });
          }
        }

        if (!text && images.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }

        context.activeTurnId = turnId;
        context.session = {
          ...context.session,
          activeTurnId: turnId,
          status: "running",
          model: model.id,
          updatedAt: nowIso(),
        };

        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
          type: "turn.started",
          payload: { model: model.id },
        });

        const run = yield* Effect.tryPromise({
          try: () =>
            context.agent.send(
              {
                text,
                ...(images.length > 0 ? { images } : {}),
              },
              { model },
            ),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "agent.send",
              detail: errorDetail(cause),
              cause,
            }),
        });
        context.activeRun = run;

        yield* Stream.fromAsyncIterable(
          run.stream(),
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "run.stream",
              detail: errorDetail(cause),
              cause,
            }),
        ).pipe(Stream.runForEach((message) => emitSdkMessage(context, turnId, message)));

        const result = yield* Effect.tryPromise({
          try: () => run.wait(),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "run.wait",
              detail: errorDetail(cause),
              cause,
            }),
        });

        appendTurnItem(context, turnId, { runId: run.id, result });
        context.activeRun = undefined;
        context.activeTurnId = undefined;
        context.session = {
          ...context.session,
          status: "ready",
          activeTurnId: turnId,
          model: result.model?.id ?? model.id,
          updatedAt: nowIso(),
        };

        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId, turnId, raw: result })),
          type: "turn.completed",
          payload: {
            state:
              result.status === "cancelled"
                ? "cancelled"
                : result.status === "error"
                  ? "failed"
                  : "completed",
            stopReason: result.status,
          },
        });

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: context.session.resumeCursor,
        };
      });

    const interruptTurn: CursorAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const run = context.activeRun;
        if (run && run.status === "running") {
          yield* Effect.tryPromise({
            try: () => run.cancel(),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "run.cancel",
                detail: errorDetail(cause),
                cause,
              }),
          });
        }
      });

    const respondToRequest: CursorAdapterShape["respondToRequest"] = (
      _threadId: ThreadId,
      _requestId: ApprovalRequestId,
      _decision: ProviderApprovalDecision,
    ) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToRequest",
          detail: "Cursor SDK does not expose interactive approval requests.",
        }),
      );

    const respondToUserInput: CursorAdapterShape["respondToUserInput"] = (
      _threadId: ThreadId,
      _requestId: ApprovalRequestId,
      _answers: ProviderUserInputAnswers,
    ) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToUserInput",
          detail: "Cursor SDK does not expose structured user-input requests.",
        }),
      );

    const readThread: CursorAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        return { threadId, turns: context.turns };
      });

    const rollbackThread: CursorAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        context.turns.splice(Math.max(0, context.turns.length - numTurns));
        return { threadId, turns: context.turns };
      });

    const stopSession: CursorAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        yield* stopContext(threadId, context);
      });

    const listSessions: CursorAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (context) => ({ ...context.session })));

    const hasSession: CursorAdapterShape["hasSession"] = (threadId) =>
      Effect.gen(function* () {
        const context = sessions.get(threadId);
        return Boolean(context) && !(yield* Ref.get(context!.stopped));
      });

    const stopAll: CursorAdapterShape["stopAll"] = () =>
      Effect.forEach(
        Array.from(sessions.entries()),
        ([threadId, context]) => stopContext(threadId, context),
        {
          discard: true,
        },
      );

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(
        Effect.ignore,
        Effect.tap(() => Queue.shutdown(runtimeEvents)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromQueue(runtimeEvents),
    } satisfies CursorAdapterShape;
  });
}
