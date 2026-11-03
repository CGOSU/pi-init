import initProjectExtension from "../../extensions/index.ts";

function createExtensionHarness(branch = [], options = {}) {
  const handlers = new Map();
  const commands = new Map();
  const entries = [];
  const notifications = [];
  const selectCalls = [];
  const customCalls = [];
  const statusCalls = [];
  const widgets = new Map();
  const renderers = new Map();
  const tools = [];
  const aborts = [];
  const reloadCalls = [];
  const sentMessages = [];
  const sentUserMessages = [];
  const defaultModel = Object.prototype.hasOwnProperty.call(options, "model")
    ? options.model
    : { provider: "test-provider", id: "session-default" };
  const availableModels = options.availableModels ?? (defaultModel ? [defaultModel] : []);
  let currentThinkingLevel = options.thinkingLevel ?? "max";
  const activeTools = options.activeTools ?? [];
  let context;

  function persistSentMessage(message = sentMessages.at(-1)?.message) {
    if (!message) throw new Error("没有待持久化的测试消息");
    const entry = {
      type: "custom_message",
      id: `test-message-${branch.length + 1}`,
      parentId: branch.at(-1)?.id ?? null,
      timestamp: new Date().toISOString(),
      ...message,
    };
    branch.push(entry);
    return entry;
  }

  async function completeCompaction(options = {}) {
    try {
      let extensionCompaction;
      const reason = options.reason ?? "manual";
      const beforeEvent = {
        type: "session_before_compact",
        preparation: {},
        branchEntries: branch,
        customInstructions: options.customInstructions,
        reason,
        willRetry: options.willRetry ?? false,
        signal: undefined,
      };
      for (const handler of handlers.get("session_before_compact") ?? []) {
        const result = handler(beforeEvent, context);
        const resolved = result && typeof result.then === "function" ? await result : result;
        if (resolved?.compaction) extensionCompaction = resolved.compaction;
      }
      const compactionEntry = {
        type: "compaction",
        id: `test-compaction-${branch.length}`,
        summary: extensionCompaction?.summary ?? "测试压缩摘要",
        firstKeptEntryId: extensionCompaction?.firstKeptEntryId ?? "test-kept-entry",
        tokensBefore: extensionCompaction?.tokensBefore ?? 100,
      };
      branch.push(compactionEntry);
      const compactEvent = {
        type: "session_compact",
        compactionEntry,
        fromExtension: Boolean(extensionCompaction),
        reason,
        willRetry: options.willRetry ?? false,
      };
      for (const handler of handlers.get("session_compact") ?? []) {
        const result = handler(compactEvent, context);
        if (result && typeof result.then === "function") await result;
      }
      options.onComplete?.(compactionEntry);
      return compactionEntry;
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
      return undefined;
    }
  }
  const pi = {
    on(name, handler) {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    },
    events: {
      on() {
        return () => {};
      },
      emit() {},
    },
    appendEntry(type, data) {
      options.appendEntry?.(type, data);
      branch.push({ type: "custom", customType: type, data });
      entries.push({ type, data });
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerEntryRenderer(type, renderer) {
      renderers.set(type, renderer);
    },
    registerTool(tool) {
      tools.push(tool);
    },
    getThinkingLevel() {
      return currentThinkingLevel;
    },
    setThinkingLevel(level) {
      currentThinkingLevel = level;
    },
    getActiveTools() {
      return activeTools;
    },
    async setModel(model) {
      if (options.setModelResult === false) return false;
      const previousModel = context?.model;
      if (context) context.model = model;
      if (
        options.emitModelSelectOnSetModel
        && context
        && (!previousModel
          || previousModel.provider !== model.provider
          || previousModel.id !== model.id)
      ) {
        for (const handler of handlers.get("model_select") ?? []) {
          await handler({ type: "model_select", model, previousModel, source: "set" }, context);
        }
      }
      return true;
    },
    async sendMessage(message, messageOptions) {
      sentMessages.push({ message, options: messageOptions });
      options.beforeSendMessagePersist?.(message, { handlers, context, branch });
      if (!options.deferSendMessagePersistence) persistSentMessage(message);
    },
    sendUserMessage(message, options) {
      sentUserMessages.push({ message, options });
    },
    async exec(command, args, execOptions) {
      if (typeof options.exec === "function") return options.exec(command, args, execOptions);
      throw new Error(`test harness exec 未配置：${command}`);
    },
  };
  initProjectExtension(pi);

  context = {
    cwd: options.cwd ?? process.cwd(),
    mode: options.mode ?? "rpc",
    hasUI: options.hasUI ?? true,
    model: defaultModel,
    scopedModels: options.scopedModels ?? [],
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return options.setModelResult === false ? { ok: false, error: "Missing credentials" } : { ok: true };
      },
      find(provider, id) {
        return availableModels.find((model) => model.provider === provider && model.id === id);
      },
      getAvailable() {
        return availableModels;
      },
    },
    isProjectTrusted() {
      return options.trusted ?? false;
    },
    getContextUsage() {
      return { percent: 0 };
    },
    isIdle() {
      return options.isIdle ?? true;
    },
    hasPendingMessages() {
      return false;
    },
    ui: {
      theme: {
        fg(_color, text) {
          return text;
        },
        bold(text) {
          return text;
        },
      },
      notify(message, level) {
        notifications.push({ message, level });
      },
      setStatus(name, text) {
        statusCalls.push({ name, text });
      },
      setWidget(name, content, widgetOptions) {
        if (content === undefined) {
          widgets.delete(name);
        } else {
          widgets.set(name, { content, options: widgetOptions });
        }
      },
      async select(title, items) {
        selectCalls.push({ title, items });
        return options.select?.(title, items);
      },
      async input(title, placeholder) {
        return options.input?.(title, placeholder);
      },
      async custom(factory, customOptions) {
        const call = { options: customOptions };
        customCalls.push(call);
        let result;
        const done = (value) => {
          call.done = true;
          result = value;
        };
        call.component = factory(
          { requestRender() {} },
          {
            fg: (_color, text) => text,
            bg: (_color, text) => text,
            bold: (text) => text,
          },
          {},
          done,
        );
        await options.custom?.(call);
        if (!call.done) done(undefined);
        return result;
      },
    },
    abort() {
      aborts.push(true);
    },
    async reload() {
      reloadCalls.push(true);
      await options.reload?.();
    },
    sessionManager: {
      getSessionId: () => options.sessionId ?? "test-session",
      getBranch() {
        return branch;
      },
    },
    compact(options) {
      completeCompaction(options);
    },
  };
  return {
    handlers,
    commands,
    entries,
    branch,
    notifications,
    selectCalls,
    customCalls,
    statusCalls,
    widgets,
    renderers,
    tools,
    aborts,
    reloadCalls,
    context,
    sentMessages,
    sentUserMessages,
    persistSentMessage,
    completeCompaction,
  };
}

async function emitToolResult(harness, event) {
  let result;
  for (const handler of harness.handlers.get("tool_result") ?? []) {
    const current = await handler(event, harness.context);
    if (current !== undefined) result = current;
  }
  return result;
}

async function emitExtensionEvent(harness, name, event = {}) {
  const emit = async (eventName, payload) => {
    // Match SDK dispatch: observers do not hide later guards or transforms.
    let result;
    let currentText = payload.text;
    let currentImages = payload.images;
    for (const handler of [...(harness.handlers.get(eventName) ?? [])]) {
      const current = await handler(eventName === "input"
        ? { ...payload, type: "input", text: currentText, images: currentImages }
        : payload, harness.context);
      if (eventName === "tool_call" && current) {
        result = current;
        if (result.block) return result;
      } else if (eventName === "input") {
        if (current?.action === "handled") return current;
        if (current?.action === "transform") {
          currentText = current.text;
          currentImages = current.images ?? currentImages;
        }
      }
    }
    if (eventName === "input") {
      return currentText !== payload.text || currentImages !== payload.images
        ? { action: "transform", text: currentText, images: currentImages }
        : { action: "continue" };
    }
    return result;
  };
  if (name === "session_start" || name === "session_shutdown" || name === "session_tree" || name === "model_select") {
    harness.testProviderRequestActive = false;
    harness.testAssistantMessageStarted = false;
  } else if (name === "before_provider_request") {
    harness.testProviderRequestActive = true;
    harness.testAssistantMessageStarted = false;
  } else if (name === "message_start" && event.message?.role === "assistant") {
    harness.testAssistantMessageStarted = true;
  } else if (name === "agent_settled") {
    harness.testProviderRequestActive = false;
    harness.testAssistantMessageStarted = false;
  }

  if (name === "message_end" && event.message?.role === "assistant"
    && harness.testProviderRequestActive && !harness.testAssistantMessageStarted) {
    const source = event.message;
    const message = {
      ...source,
      content: source.content ?? [],
      api: source.api ?? "test-api",
      provider: source.provider ?? harness.context.model?.provider ?? "test-provider",
      model: source.model ?? harness.context.model?.id ?? "test-model",
      timestamp: typeof source.timestamp === "number" ? source.timestamp : Date.now(),
    };
    await emit("message_start", { type: "message_start", message });
    event = { ...event, message };
  }
  const result = await emit(name, event);
  if (name === "message_end" && event.message?.role === "assistant") {
    harness.testProviderRequestActive = false;
    harness.testAssistantMessageStarted = false;
  }
  return result;
}

async function runExternalAgent(harness, source, options = {}) {
  await emitExtensionEvent(harness, "input", { source });
  await emitExtensionEvent(harness, "before_agent_start");
  await emitExtensionEvent(harness, "agent_start");
  await emitExtensionEvent(harness, "before_provider_request");
  const responseMessage = {
    role: "assistant",
    content: [],
    api: "test-api",
    provider: harness.context.model?.provider ?? "test-provider",
    model: harness.context.model?.id ?? "test-model",
    usage: { cacheRead: 0, cacheWrite: 0 },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  await emitExtensionEvent(harness, "message_start", { message: responseMessage });
  await emitExtensionEvent(harness, "message_update", {
    message: responseMessage,
    assistantMessageEvent: { type: "text_delta", partial: responseMessage },
  });
  await emitExtensionEvent(harness, "message_end", { message: responseMessage });
  if (options.toolName) {
    await emitExtensionEvent(harness, "tool_execution_start", {
      toolCallId: "test-tool-call",
      toolName: options.toolName,
      args: {},
    });
    await emitExtensionEvent(harness, "tool_execution_end", {
      toolCallId: "test-tool-call",
      toolName: options.toolName,
      result: {},
      isError: false,
    });
  }
  await emitExtensionEvent(harness, "agent_end");
  await emitExtensionEvent(harness, "agent_start");
  await emitExtensionEvent(harness, "message_end", { message: { role: "assistant" } });
  await emitExtensionEvent(harness, "agent_end");
  await emitExtensionEvent(harness, "agent_settled");
}

export { createExtensionHarness, emitExtensionEvent, emitToolResult, runExternalAgent };
