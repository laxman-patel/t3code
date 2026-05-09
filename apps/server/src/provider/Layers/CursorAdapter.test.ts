import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CursorSettings,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import { Cause, Effect, Fiber, Layer, Schema, Scope, Stream } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ServerConfig } from "../../config.ts";
import { makeCursorAdapter } from "./CursorAdapter.ts";

const cursorSdkMock = vi.hoisted(() => ({
  create: vi.fn(),
  resume: vi.fn(),
}));

vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: cursorSdkMock.create,
    resume: cursorSdkMock.resume,
  },
}));

const PROVIDER = ProviderDriverKind.make("cursor");

function makeCursorSettings(overrides: Partial<CursorSettings> = {}): CursorSettings {
  return {
    ...Schema.decodeSync(CursorSettings)({}),
    enabled: true,
    apiKey: "test-cursor-api-key",
    ...overrides,
  };
}

function makeMockRun(input?: {
  readonly status?: "running" | "finished" | "error" | "cancelled";
  readonly messages?: ReadonlyArray<unknown>;
}) {
  return {
    id: "run-1",
    agentId: "agent-1",
    status: input?.status ?? "finished",
    result: "done",
    model: { id: "composer-2" },
    durationMs: 1,
    git: undefined,
    createdAt: Date.now(),
    supports: vi.fn(() => true),
    unsupportedReason: vi.fn(() => undefined),
    stream: async function* () {
      for (const message of input?.messages ?? []) {
        yield message;
      }
    },
    conversation: vi.fn(async () => []),
    wait: vi.fn(async () => ({
      id: "run-1",
      status: input?.status === "cancelled" ? "cancelled" : "finished",
      model: { id: "composer-2" },
      result: "done",
    })),
    cancel: vi.fn(async () => undefined),
    onDidChangeStatus: vi.fn(() => () => undefined),
  };
}

function makeMockAgent(run = makeMockRun()) {
  return {
    agentId: "agent-1",
    model: { id: "composer-2" },
    send: vi.fn(async () => run),
    close: vi.fn(),
    reload: vi.fn(async () => undefined),
    [Symbol.asyncDispose]: vi.fn(async () => undefined),
    listArtifacts: vi.fn(async () => []),
    downloadArtifact: vi.fn(async () => Buffer.alloc(0)),
  };
}

function runAdapterEffect<A, E>(
  effect: Effect.Effect<A, E, NodeServices.NodeServices | ServerConfig | Scope.Scope>,
): Promise<A> {
  return Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-cursor-adapter-test-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    ),
  );
}

describe("CursorAdapterLive", () => {
  beforeEach(() => {
    cursorSdkMock.create.mockReset();
    cursorSdkMock.resume.mockReset();
  });

  it("requires a Cursor SDK API key before starting a session", async () => {
    const exit = await runAdapterEffect(
      Effect.gen(function* () {
        const adapter = yield* makeCursorAdapter(makeCursorSettings({ apiKey: "" }));
        return yield* Effect.exit(
          adapter.startSession({
            provider: PROVIDER,
            threadId: ThreadId.make("cursor-missing-key"),
            cwd: process.cwd(),
            runtimeMode: "approval-required",
          }),
        );
      }),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.pretty(exit.cause)).toContain("ProviderAdapterValidationError");
    }
  });

  it("creates an SDK local agent and streams assistant text as runtime events", async () => {
    const run = makeMockRun({
      messages: [
        {
          type: "assistant",
          agent_id: "agent-1",
          run_id: "run-1",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "hello from cursor" }],
          },
        },
      ],
    });
    const agent = makeMockAgent(run);
    cursorSdkMock.create.mockResolvedValue(agent);

    const events: ProviderRuntimeEvent[] = [];
    await runAdapterEffect(
      Effect.gen(function* () {
        const adapter = yield* makeCursorAdapter(makeCursorSettings());
        const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => events.push(event)),
        ).pipe(Effect.forkScoped);

        const threadId = ThreadId.make("cursor-sdk-thread");
        const session = yield* adapter.startSession({
          provider: PROVIDER,
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          modelSelection: {
            instanceId: "cursor" as never,
            model: "composer-2",
          },
        });
        const turn = yield* adapter.sendTurn({
          threadId,
          input: "say hello",
        });

        yield* Effect.sleep("10 millis");
        yield* adapter.stopSession(threadId);
        yield* Effect.sleep("10 millis");
        yield* Fiber.interrupt(eventFiber);

        expect(session.resumeCursor).toEqual({
          schemaVersion: 2,
          agentId: "agent-1",
          runtime: "local",
        });
        expect(turn.threadId).toBe(threadId);
      }),
    );

    expect(cursorSdkMock.create).toHaveBeenCalledWith({
      apiKey: "test-cursor-api-key",
      model: { id: "composer-2" },
      local: { cwd: process.cwd() },
    });
    expect(agent.send).toHaveBeenCalledWith({ text: "say hello" }, { model: { id: "composer-2" } });
    expect(events.some((event) => event.type === "content.delta")).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "content.delta" &&
          event.payload.streamKind === "assistant_text" &&
          event.payload.delta === "hello from cursor",
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === "turn.completed")).toBe(true);
    expect(agent.close).toHaveBeenCalled();
  });

  it("resumes SDK agents from Cursor resume cursors", async () => {
    const agent = makeMockAgent();
    cursorSdkMock.resume.mockResolvedValue(agent);

    await runAdapterEffect(
      Effect.gen(function* () {
        const adapter = yield* makeCursorAdapter(makeCursorSettings());
        yield* adapter.startSession({
          provider: PROVIDER,
          threadId: ThreadId.make("cursor-sdk-resume"),
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          resumeCursor: { schemaVersion: 2, agentId: "agent-existing" },
        });
      }),
    );

    expect(cursorSdkMock.resume).toHaveBeenCalledWith("agent-existing", {
      apiKey: "test-cursor-api-key",
      model: { id: "default" },
      local: { cwd: process.cwd() },
    });
  });

  it("uses the resume cursor runtime instead of current settings when resuming", async () => {
    const agent = makeMockAgent();
    cursorSdkMock.resume.mockResolvedValue(agent);

    await runAdapterEffect(
      Effect.gen(function* () {
        const adapter = yield* makeCursorAdapter(
          makeCursorSettings({
            cloudEnabled: true,
            cloudRepositoryUrl: "https://github.com/acme/widgets",
          }),
        );
        const session = yield* adapter.startSession({
          provider: PROVIDER,
          threadId: ThreadId.make("cursor-sdk-local-resume-with-cloud-enabled"),
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          resumeCursor: { schemaVersion: 2, agentId: "agent-existing", runtime: "local" },
        });

        expect(session.resumeCursor).toEqual({
          schemaVersion: 2,
          agentId: "agent-1",
          runtime: "local",
        });
      }),
    );

    expect(cursorSdkMock.resume).toHaveBeenCalledWith("agent-existing", {
      apiKey: "test-cursor-api-key",
      model: { id: "default" },
      local: { cwd: process.cwd() },
    });
  });

  it("creates an SDK cloud agent when Cursor cloud agents are enabled", async () => {
    const agent = makeMockAgent();
    cursorSdkMock.create.mockResolvedValue(agent);

    await runAdapterEffect(
      Effect.gen(function* () {
        const adapter = yield* makeCursorAdapter(
          makeCursorSettings({
            cloudEnabled: true,
            cloudRepositoryUrl: "https://github.com/acme/widgets",
            cloudStartingRef: "main",
            cloudAutoCreatePr: true,
          }),
        );
        const session = yield* adapter.startSession({
          provider: PROVIDER,
          threadId: ThreadId.make("cursor-sdk-cloud"),
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          modelSelection: {
            instanceId: "cursor" as never,
            model: "gpt-5.5",
          },
        });

        expect(session.resumeCursor).toEqual({
          schemaVersion: 2,
          agentId: "agent-1",
          runtime: "cloud",
        });
      }),
    );

    expect(cursorSdkMock.create).toHaveBeenCalledWith({
      apiKey: "test-cursor-api-key",
      model: { id: "gpt-5.5" },
      cloud: {
        repos: [{ url: "https://github.com/acme/widgets", startingRef: "main" }],
        autoCreatePR: true,
      },
    });
  });
});
