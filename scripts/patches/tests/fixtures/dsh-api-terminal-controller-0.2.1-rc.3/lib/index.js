import z from "@deepseek-ai/schemastery";
import { Remote, RemoteError, TypertRemoteService, remoteErrorOf } from "@deepseek-ai/dsh-typert-protocol";
import { assertNever } from "@deepseek-ai/dsh-util-values";
import { createLazyRequire } from "@deepseek-ai/dsh-lazy-require";
import { Deque } from "@deepseek-ai/dsh-deque";
//#region lib/types/shells.js
/**
* Resolve the configured shell or the execution environment's default shell.
* @param subprocess - target execution provider.
* @param configured - optional profile overriding the environment's default shell.
* @param signal - resolution cancellation.
* @returns one verified shell; a declared default that cannot resolve rejects.
*/
async function resolveShell(subprocess, configured, signal) {
	let shell = configured;
	if (shell === void 0) {
		const environment = await subprocess.terminalEnvironment(signal);
		shell = profile(environment.defaultShell ?? (environment.platform === "windows" ? "cmd.exe" : "/bin/sh"));
	}
	const path = await subprocess.resolveExecutable(shell.path, void 0, signal);
	return {
		...shell,
		path
	};
}
function profile(path) {
	const kind = shellKind(path);
	return {
		path,
		name: executableName(path),
		args: kind === "cmd" ? [] : kind === "pwsh" || kind === "powershell" ? ["-NoLogo"] : ["-i"]
	};
}
function executableName(path) {
	return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}
function shellKind(path) {
	return executableName(path).toLowerCase().replace(/\.exe$/u, "");
}
/**
* List verified candidates after the configured or environment-default shell, one per executable name ignoring case and `.exe`.
* PATH lookup can reach the default through another directory, such as `/usr/bin/bash` for `/bin/bash` on merged-`/usr` systems.
* @param subprocess - target execution provider.
* @param configured - optional default profile.
* @param candidates - executable names or paths permitted for shell selection.
* @param signal - discovery cancellation.
* @returns installed shells with the default first, keeping the earliest entry per name; transport failures reject.
*/
async function discoverShells(subprocess, configured, candidates, signal) {
	const preferred = await resolveShell(subprocess, configured, signal);
	const found = await Promise.all(candidates.map(async (candidate) => {
		try {
			return await resolveShell(subprocess, profile(candidate), signal);
		} catch (error) {
			if (typeof error === "object" && error !== null && "name" in error && error.name === "SubprocessExecutableNotFoundError") return void 0;
			throw error;
		}
	}));
	const shells = /* @__PURE__ */ new Map();
	for (const shell of [preferred, ...found]) {
		if (shell === void 0) continue;
		const kind = shellKind(shell.path);
		if (!shells.has(kind)) shells.set(kind, shell);
	}
	return [...shells.values()];
}
//#endregion
//#region lib/types/stream.js
/** A bounded output queue for one Remote stream generation. */
/** Slow followers fail explicitly; a later attachment recovers from the screen. */
var TerminalFollower = class {
	maxBytes;
	queue = new Deque();
	bytes = 0;
	wake;
	closed = false;
	finished = false;
	failure;
	/** Whether this attachment still accepts input and output. */
	get active() {
		return !this.closed && !this.finished;
	}
	/** @param maxBytes - maximum queued UTF-8 bytes for this follower. */
	constructor(maxBytes) {
		this.maxBytes = maxBytes;
	}
	/**
	* Queue a frame or fail this follower when its byte limit is exceeded.
	* @param frame - next ordered frame.
	*/
	push(frame) {
		if (this.closed || this.finished) return;
		const bytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
		if (this.bytes + bytes > this.maxBytes) {
			this.fail(/* @__PURE__ */ new Error("Terminal output consumer exceeded its buffer; reconnect to recover the current screen"));
			return;
		}
		this.queue.pushBack({
			frame,
			bytes
		});
		this.bytes += bytes;
		this.wake?.();
	}
	/**
	* Fail this attachment without stopping its terminal; failures after finish or close are ignored.
	* @param error - input or output failure reported to the attached consumer.
	*/
	fail(error) {
		if (!this.active) return;
		this.failure = error;
		this.close();
	}
	/** Finish after delivering every queued frame, including the final exit state. */
	finish() {
		this.finished = true;
		this.wake?.();
	}
	/** Stop this follower without stopping its terminal. */
	close() {
		this.closed = true;
		this.queue.clear();
		this.bytes = 0;
		this.wake?.();
	}
	/**
	* Drain until detached or failed.
	* @param signal - Remote generation cancellation.
	* @returns ordered terminal frames.
	*/
	async *read(signal) {
		const abort = () => {
			this.close();
		};
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		try {
			while (!this.closed) {
				const next = this.queue.popFront();
				if (next !== void 0) {
					this.bytes -= next.bytes;
					yield next.frame;
				} else {
					if (this.finished) break;
					await new Promise((resolve) => {
						this.wake = resolve;
					});
					this.wake = void 0;
				}
			}
			if (this.failure !== void 0) throw this.failure;
		} finally {
			signal.removeEventListener("abort", abort);
			this.close();
		}
	}
};
//#endregion
//#region lib/types/retention.js
/** Window holds and conservative idle reclamation for one terminal owner. */
/** Exactly one owner orders holds, observation, and retryable process cleanup. */
var TerminalRetention = class {
	policy;
	inspect;
	terminate;
	failed;
	lifetime = new AbortController();
	holders = /* @__PURE__ */ new Set();
	epoch = 0;
	timer;
	observation;
	idle;
	closing = false;
	disposed = false;
	cleanup;
	/**
	* @param policy - deployment timing choices.
	* @param inspect - fresh shell and owned-job observation.
	* @param terminate - mark the identity closed, await process quiescence, and remove its owner record.
	* @param failed - diagnostic sink for failed automatic cleanup.
	*/
	constructor(policy, inspect, terminate, failed) {
		this.policy = policy;
		this.inspect = inspect;
		this.terminate = terminate;
		this.failed = failed;
		this.schedule(0);
	}
	/**
	* Hold one terminal for one physical Remote stream, independently of screen subscriptions.
	* @param signal - transport generation lifetime.
	* @returns acknowledgement followed by an open stream until cancellation or terminal closure.
	*/
	async *retain(signal) {
		signal.throwIfAborted();
		if (this.closing || this.disposed) throw new RemoteError("terminal/unavailable", "Terminal is closing or unavailable", {});
		const holder = {};
		const ended = Promise.withResolvers();
		const combined = AbortSignal.any([signal, this.lifetime.signal]);
		const release = () => {
			if (!this.holders.delete(holder)) return;
			combined.removeEventListener("abort", release);
			this.invalidate();
			ended.resolve();
			this.schedule(0);
		};
		this.holders.add(holder);
		this.invalidate();
		this.cancelTimer();
		combined.addEventListener("abort", release, { once: true });
		try {
			yield { type: "retained" };
			await ended.promise;
		} finally {
			release();
		}
	}
	/** Invalidate outstanding idle observations before accepting input. */
	invalidate() {
		this.epoch++;
		this.idle = void 0;
	}
	/**
	* Start or join cleanup; failure keeps the identity closed and schedules one retry.
	* @returns after owned process cleanup succeeds, or rejects with its failure.
	*/
	close() {
		if (this.cleanup !== void 0) return this.cleanup;
		this.closing = true;
		this.invalidate();
		this.lifetime.abort(/* @__PURE__ */ new Error("Terminal closed"));
		this.cancelTimer();
		this.cleanup = this.terminate().catch((error) => {
			this.cleanup = void 0;
			this.schedule(this.policy.cleanupRetryMs);
			throw error;
		});
		return this.cleanup;
	}
	/**
	* Stop timers and streams and await both observation and final cleanup.
	* @returns after process quiescence; cleanup failure is reported to the disposing owner.
	*/
	async dispose() {
		this.disposed = true;
		this.cancelTimer();
		const observation = this.observation;
		try {
			await this.close();
		} finally {
			await observation;
		}
	}
	cancelTimer() {
		clearTimeout(this.timer);
		this.timer = void 0;
	}
	schedule(delay) {
		if (this.disposed || this.timer !== void 0) return;
		if (!this.closing && (this.holders.size > 0 || this.policy.unattendedTimeoutMs === 0)) return;
		const due = performance.now() + delay;
		this.timer = setTimeout(() => {
			this.timer = void 0;
			const remaining = due - performance.now();
			if (remaining > 0) {
				this.schedule(remaining);
				return;
			}
			if (this.closing) {
				this.close().catch(this.failed);
				return;
			}
			this.observe();
		}, Math.min(delay, 2147483647));
		this.timer.unref();
	}
	observe() {
		if (this.observation !== void 0) return;
		const epoch = this.epoch;
		this.observation = (async () => {
			let activity;
			try {
				activity = await this.inspect();
			} catch (_activityUnavailable) {
				activity = {
					state: "unknown",
					revision: 0
				};
			}
			if (this.disposed || this.closing || this.holders.size > 0 || epoch !== this.epoch) return;
			const now = performance.now();
			if (activity.state !== "idle") {
				this.idle = void 0;
				return;
			}
			if (this.idle?.revision !== activity.revision || now - this.idle.observedAt > this.policy.activityPollIntervalMs * 2) this.idle = {
				since: now,
				observedAt: now,
				revision: activity.revision
			};
			else this.idle.observedAt = now;
			if (now - this.idle.since >= this.policy.unattendedTimeoutMs) await this.close();
		})().catch(this.failed).finally(() => {
			this.observation = void 0;
			if (!this.closing) this.schedule(this.policy.activityPollIntervalMs);
		});
	}
};
//#endregion
//#region lib/types/terminal.js
/** One PTY, a bounded terminal emulator and its detachable browser followers. */
const requireHeadless = createLazyRequire("@xterm/headless", import.meta.url);
const requireSerialize = createLazyRequire("@xterm/addon-serialize", import.meta.url);
/** Process lifetime is independent of follower and component lifetimes. */
var BrowserTerminal = class {
	handle;
	info;
	maxBufferedBytes;
	screen;
	serializer;
	followers = /* @__PURE__ */ new Set();
	sequence = 0;
	operations = Promise.resolve();
	drained;
	/** Provider completion precedes output drainage and the published exit state. */
	exited = false;
	closing;
	retention;
	controller;
	/**
	* @param handle - allocated terminal process range.
	* @param info - initial metadata.
	* @param scrollback - maximum retained scrollback rows.
	* @param maxBufferedBytes - per-follower queue cap.
	*/
	constructor(handle, info, scrollback, maxBufferedBytes) {
		this.handle = handle;
		this.info = info;
		this.maxBufferedBytes = maxBufferedBytes;
		const { Terminal } = requireHeadless();
		const { SerializeAddon } = requireSerialize();
		this.screen = new Terminal({
			cols: info.cols,
			rows: info.rows,
			scrollback,
			allowProposedApi: true
		});
		this.serializer = new SerializeAddon();
		this.screen.loadAddon(this.serializer);
		this.drained = this.consume();
	}
	/**
	* Start monitoring after this allocation is committed to its Session owner.
	* @param policy - validated Host timing policy.
	* @param closing - closes the id before any asynchronous termination.
	* @param closed - removes the exact successfully terminated owner record.
	* @param failed - diagnostic sink for background cleanup failure.
	*/
	monitor(policy, closing, closed, failed) {
		this.retention = new TerminalRetention(policy, () => this.handle.inspectActivity(), async () => {
			closing();
			await this.closeProcess();
			closed();
		}, failed);
	}
	/**
	* Retain this committed process independently of output attachment.
	* @param signal - physical window stream lifetime.
	* @returns its hold acknowledgement and lifetime.
	*/
	retain(signal) {
		if (this.retention === void 0) throw new Error("Terminal has not been committed");
		return this.retention.retain(signal);
	}
	/**
	* Attach with exclusive input control; older attachments keep receiving output.
	* @param input - Gateway-decoded commands; returning its iterator must interrupt pending reads.
	* @param limits - input byte and PTY dimension limits validated at the Remote boundary.
	* @param signal - attachment cancellation; never terminates the process.
	* @param inputWindow - carrier frame capacity; absent for a carrier without an encoded-frame inbox limit.
	* @returns a screen baseline, output, per-attachment state and ordered command acknowledgements.
	*/
	async *attach(input, limits, signal, inputWindow) {
		signal.throwIfAborted();
		const follower = new TerminalFollower(this.maxBufferedBytes);
		const baseline = await this.enqueue(() => {
			signal.throwIfAborted();
			this.controller = follower;
			this.broadcastState();
			const snapshot = {
				type: "snapshot",
				sequence: this.sequence,
				screen: this.serializer.serialize(),
				info: this.info,
				writable: this.writable(follower),
				...inputWindow === void 0 ? {} : { inputWindow }
			};
			this.followers.add(follower);
			return snapshot;
		});
		const uplink = input[Symbol.asyncIterator]();
		const commands = this.consumeInput(uplink, follower, limits, signal).catch((error) => {
			follower.fail(error instanceof Error ? error : new Error(String(error)));
		});
		try {
			yield baseline;
			yield* follower.read(signal);
		} finally {
			this.followers.delete(follower);
			follower.close();
			if (this.controller === follower) {
				this.controller = void 0;
				this.broadcastState();
			}
			await uplink.return?.();
			await commands;
		}
	}
	async consumeInput(input, follower, limits, signal) {
		let sequence = 0;
		while (true) {
			const next = await input.next();
			if (next.done === true || signal.aborted || !follower.active) return;
			const command = next.value;
			if (!Number.isSafeInteger(command.sequence) || command.sequence !== ++sequence) throw new Error("Terminal input sequence has a gap");
			try {
				await this.enqueue(async () => {
					signal.throwIfAborted();
					this.requireController(follower);
					switch (command.type) {
						case "write":
							if (Buffer.byteLength(command.data, "utf8") > limits.maxInputBytes) throw new Error("Terminal input exceeds the configured limit");
							this.retention?.invalidate();
							await this.handle.write(command.data);
							break;
						case "resize":
							if (!Number.isSafeInteger(command.cols) || command.cols < 2 || command.cols > limits.maxCols || !Number.isSafeInteger(command.rows) || command.rows < 1 || command.rows > limits.maxRows) throw new Error("Terminal dimensions exceed the configured limits");
							await this.handle.resize(command.cols, command.rows);
							this.screen.resize(command.cols, command.rows);
							this.info = {
								...this.info,
								cols: command.cols,
								rows: command.rows
							};
							this.broadcastState();
							break;
						/* v8 ignore next -- the Gateway codec validates this closed union. */
						default: assertNever(command);
					}
				});
				follower.push({
					type: "ack",
					sequence
				});
			} catch (error) {
				const failure = remoteErrorOf(error);
				if (failure?.code === "terminal/control-unavailable") follower.push({
					type: "ack",
					sequence,
					refusal: failure.details.reason
				});
				else if (this.exited) follower.push({
					type: "ack",
					sequence,
					refusal: "not-running"
				});
				else throw error;
			}
		}
	}
	writable(follower) {
		return !this.exited && this.closing === void 0 && this.info.state === "running" && this.controller === follower;
	}
	broadcastState() {
		for (const follower of this.followers) follower.push({
			type: "state",
			info: this.info,
			writable: this.writable(follower)
		});
	}
	/**
	* Publish a display name to every attached view.
	* @param title - validated user title.
	*/
	rename(title) {
		this.info = {
			...this.info,
			title
		};
		this.broadcastState();
	}
	/**
	* Terminate the complete provider-owned process range before releasing its screen.
	* @returns after process cleanup and final output drainage; failures remain retryable.
	*/
	close() {
		return this.retention?.close() ?? this.closeProcess();
	}
	/**
	* Stop unattended cleanup scheduling and await final process cleanup.
	* @returns after terminal and monitor quiescence.
	*/
	dispose() {
		return this.retention?.dispose() ?? this.closeProcess();
	}
	closeProcess() {
		if (this.closing !== void 0) return this.closing;
		this.closing = (async () => {
			await this.handle.terminate();
			await this.drained;
			for (const follower of this.followers) follower.finish();
			this.followers.clear();
			this.screen.dispose();
		})().catch((error) => {
			this.closing = void 0;
			throw error;
		});
		return this.closing;
	}
	requireController(follower) {
		if (this.exited || this.closing !== void 0 || this.info.state !== "running") throw new RemoteError("terminal/control-unavailable", "Terminal is not running", { reason: "not-running" });
		if (this.controller !== follower || !follower.active) throw new RemoteError("terminal/control-unavailable", "Terminal input is controlled by another attachment", { reason: "read-only" });
	}
	broadcast(frame) {
		for (const follower of this.followers) follower.push(frame);
	}
	enqueue(operation) {
		const pending = this.operations.then(operation);
		this.operations = pending.catch(() => {});
		return pending;
	}
	async consume() {
		const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
		const outcome = this.handle.done.then((value) => {
			this.exited = true;
			return { value };
		}, (error) => ({ error }));
		try {
			for await (const chunk of this.handle.output) {
				const data = decoder.decode(chunk, { stream: true });
				await this.output(data);
			}
			await this.output(decoder.decode());
			const result = await outcome;
			if ("error" in result) throw result.error;
			this.info = {
				...this.info,
				state: "exited",
				exitCode: result.value.exitCode
			};
		} catch (error) {
			this.info = {
				...this.info,
				state: "failed",
				error: error instanceof Error ? error.message : String(error)
			};
		}
		this.broadcastState();
	}
	async output(data) {
		if (data.length === 0) return;
		await this.enqueue(async () => {
			await new Promise((resolve) => {
				this.screen.write(data, resolve);
			});
			this.broadcast({
				type: "output",
				sequence: ++this.sequence,
				data
			});
		});
	}
};
//#endregion
//#region lib/types/index.js
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
/** Typed Remote control of transient Session-owned terminal processes. */
let TerminalController = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _environment_decorators;
	let _shells_decorators;
	let _list_decorators;
	let _create_decorators;
	let _retain_decorators;
	let _attach_decorators;
	let _rename_decorators;
	let _close_decorators;
	return class TerminalController extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_environment_decorators = [Remote];
			_shells_decorators = [Remote];
			_list_decorators = [Remote];
			_create_decorators = [Remote];
			_retain_decorators = [Remote({ mode: "stream" })];
			_attach_decorators = [Remote({ mode: "stream" })];
			_rename_decorators = [Remote];
			_close_decorators = [Remote];
			__esDecorate(this, null, _environment_decorators, {
				kind: "method",
				name: "environment",
				static: false,
				private: false,
				access: {
					has: (obj) => "environment" in obj,
					get: (obj) => obj.environment
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _shells_decorators, {
				kind: "method",
				name: "shells",
				static: false,
				private: false,
				access: {
					has: (obj) => "shells" in obj,
					get: (obj) => obj.shells
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _list_decorators, {
				kind: "method",
				name: "list",
				static: false,
				private: false,
				access: {
					has: (obj) => "list" in obj,
					get: (obj) => obj.list
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _create_decorators, {
				kind: "method",
				name: "create",
				static: false,
				private: false,
				access: {
					has: (obj) => "create" in obj,
					get: (obj) => obj.create
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _retain_decorators, {
				kind: "method",
				name: "retain",
				static: false,
				private: false,
				access: {
					has: (obj) => "retain" in obj,
					get: (obj) => obj.retain
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _attach_decorators, {
				kind: "method",
				name: "attach",
				static: false,
				private: false,
				access: {
					has: (obj) => "attach" in obj,
					get: (obj) => obj.attach
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _rename_decorators, {
				kind: "method",
				name: "rename",
				static: false,
				private: false,
				access: {
					has: (obj) => "rename" in obj,
					get: (obj) => obj.rename
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _close_decorators, {
				kind: "method",
				name: "close",
				static: false,
				private: false,
				access: {
					has: (obj) => "close" in obj,
					get: (obj) => obj.close
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		config = __runInitializers(this, _instanceExtraInitializers);
		static inject = [
			"subprocess",
			"sandboxPolicy",
			"workingDirectory",
			"typert"
		];
		static Config = z.object({
			shell: z.union([z.object({
				path: z.string().required(),
				name: z.string().required(),
				args: z.array(z.string()).default([])
			}), z.const(void 0)]),
			shellCandidates: z.array(z.string().min(1)).default([
				"zsh",
				"bash",
				"fish",
				"pwsh",
				"powershell",
				"cmd"
			]),
			maxTerminals: z.number().step(1).min(1).default(8),
			maxCols: z.number().step(1).min(2).default(500),
			maxRows: z.number().step(1).min(1).default(200),
			scrollback: z.number().step(1).min(0).default(1e3),
			maxBufferedBytes: z.number().step(1).min(1024).default(2 * 1024 * 1024),
			maxInputBytes: z.number().step(1).min(1).default(64 * 1024),
			disposeGraceMs: z.number().step(1).min(1).default(1e3),
			unattendedTimeoutMs: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(72e5),
			activityPollIntervalMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(3e4),
			cleanupRetryMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(6e4)
		});
		owners = /* @__PURE__ */ new Map();
		lifetime = new AbortController();
		/**
		* @param ctx - Host context carrying typed Remote and execution providers.
		* @param config - validated terminal limits and optional shell profile.
		*/
		constructor(ctx, config) {
			super(ctx, "terminalController", { namespace: "terminal" });
			this.config = config;
			ctx.effect(() => async () => {
				this.lifetime.abort(/* @__PURE__ */ new Error("Terminal controller disposed"));
				const errors = (await Promise.allSettled([...this.owners].map(([id, owner]) => this.disposeOwner(id, owner)))).filter((result) => result.status === "rejected").map((result) => result.reason);
				if (errors.length > 0) throw new AggregateError(errors, "Browser terminal cleanup failed");
			}, "terminal-controller.processes");
		}
		/**
		* Read the Session's current directory and terminal limits without filesystem validation or shell lookup.
		* @param agent - Session owner supplied by the Gateway.
		* @param signal - request cancellation.
		* @returns the logged current directory and terminal limits; retained terminals keep their own process directories.
		*/
		environment(agent, signal) {
			signal.throwIfAborted();
			const { workingDirectory } = this.execution(agent);
			return {
				cwd: workingDirectory.get(agent.session),
				maxInputBytes: this.config.maxInputBytes,
				maxBufferedBytes: this.config.maxBufferedBytes,
				maxCols: this.config.maxCols,
				maxRows: this.config.maxRows,
				scrollback: this.config.scrollback
			};
		}
		/**
		* Discover installed shells in the Session's execution environment.
		* @param agent - Session owner supplied by the Gateway.
		* @param signal - request cancellation.
		* @returns verified profiles, with the configured or system default first.
		*/
		shells(agent, signal) {
			signal.throwIfAborted();
			return discoverShells(this.execution(agent).subprocess, this.config.shell, this.config.shellCandidates, signal);
		}
		/**
		* List retained terminals without resolving or activating an Agent.
		* @param sessionId - displayed Session identity, including offline history.
		* @returns terminals retained for this Host lifetime.
		*/
		list(sessionId) {
			const owner = this.owners.get(sessionId);
			if (owner === void 0) return [];
			return [...owner.terminals.values(), ...owner.allocations.values()].map((terminal) => terminal.info);
		}
		/**
		* Allocate a user shell once for a caller-generated identity, without Agent sandbox or approval restrictions.
		* @param agent - Session owner supplied by the Gateway.
		* @param request - initial dimensions and idempotency identity.
		* @param signal - allocation cancellation; committed terminals survive disconnection.
		* @returns the existing or newly committed terminal.
		*/
		async create(agent, request, signal) {
			this.lifetime.signal.throwIfAborted();
			if (!/^[\w-]{1,128}$/u.test(request.id)) throw new Error("Invalid terminal identity");
			this.dimensions(request.cols, request.rows);
			const owner = this.owner(agent);
			owner.lifetime.signal.throwIfAborted();
			this.requireOpen(owner, request.id);
			const existing = owner.terminals.get(request.id);
			if (existing !== void 0) return existing.info;
			const pending = owner.pending.get(request.id);
			if (pending !== void 0) {
				const terminal = await pending;
				this.requireOpen(owner, request.id);
				return terminal.info;
			}
			if (new Set([
				...owner.terminals.keys(),
				...owner.pending.keys(),
				...owner.allocations.keys()
			]).size >= this.config.maxTerminals) throw new RemoteError("terminal/limit-reached", "Session terminal limit reached", { limit: this.config.maxTerminals });
			const allocation = this.spawn(agent, owner, request, AbortSignal.any([
				signal,
				this.lifetime.signal,
				owner.lifetime.signal
			]));
			owner.pending.set(request.id, allocation);
			try {
				const terminal = await allocation;
				owner.terminals.set(request.id, terminal);
				owner.allocations.delete(request.id);
				terminal.monitor(this.config, () => {
					owner.closedIds.add(request.id);
				}, () => {
					owner.terminals.delete(request.id);
				}, (error) => {
					this.ctx.logger.error("Browser terminal cleanup failed", error);
				});
				this.requireOpen(owner, request.id);
				return terminal.info;
			} finally {
				owner.pending.delete(request.id);
			}
		}
		/**
		* Retain an existing terminal for a window without activating its Agent or taking input control.
		* @param sessionId - owning Session identity, including an inactive saved layout.
		* @param id - retained Host terminal identity.
		* @param signal - physical Remote stream cancellation.
		* @returns a hold acknowledgement followed by an open lifetime stream.
		*/
		retain(sessionId, id, signal) {
			const owner = this.owners.get(sessionId);
			const terminal = owner?.terminals.get(id);
			if (terminal === void 0 || owner?.closedIds.has(id) === true || owner?.lifetime.signal.aborted === true) throw new RemoteError("terminal/unavailable", "Terminal is closing or unavailable", {});
			return terminal.retain(signal);
		}
		/**
		* Attach terminal input and output to one physical Remote stream.
		* @param agent - Session owner supplied by the Gateway.
		* @param id - terminal identity.
		* @param signal - attachment cancellation; the process remains alive and input is never replayed.
		* @returns screen recovery, output, writable state and provider-acceptance acknowledgements.
		*/
		attach(agent, id, signal) {
			const invocation = this.ctx.invocation;
			if (invocation === void 0) throw new Error("Terminal attachment requires a Remote invocation");
			return this.terminal(agent, id).attach(invocation.uplink(), this.config, signal, invocation.uplinkWindow);
		}
		/**
		* Rename a terminal without changing its shell.
		* @param agent - Session owner supplied by the Gateway.
		* @param id - terminal identity.
		* @param title - nonempty display title, at most 120 characters.
		*/
		rename(agent, id, title) {
			if (title.trim().length === 0 || title.length > 120) throw new Error("Terminal title must contain 1–120 characters");
			this.terminal(agent, id).rename(title.trim());
		}
		/**
		* Close an identity to future creation and kill its process range; repeated closes succeed.
		* @param agent - Session owner supplied by the Gateway.
		* @param id - terminal identity.
		* @returns after provider cleanup succeeds. A failure retains the terminal for retry.
		*/
		async close(agent, id) {
			const owner = this.owner(agent);
			owner.closedIds.add(id);
			await owner.pending.get(id)?.catch(() => {});
			const terminal = owner.terminals.get(id);
			if (terminal !== void 0) {
				await terminal.close();
				owner.terminals.delete(id);
			} else {
				const allocation = owner.allocations.get(id);
				if (allocation === void 0) return;
				await allocation.cleanup.close();
				owner.allocations.delete(id);
			}
		}
		owner(agent) {
			let owner = this.owners.get(agent.id);
			if (owner === void 0) {
				owner = {
					terminals: /* @__PURE__ */ new Map(),
					pending: /* @__PURE__ */ new Map(),
					allocations: /* @__PURE__ */ new Map(),
					closedIds: /* @__PURE__ */ new Set(),
					lifetime: new AbortController()
				};
				this.owners.set(agent.id, owner);
				const owned = owner;
				agent.ctx.effect(() => async () => {
					await this.disposeOwner(agent.id, owned);
				}, "terminal-controller.owner");
			}
			return owner;
		}
		disposeOwner(id, owner) {
			if (owner.cleanup !== void 0) return owner.cleanup;
			owner.lifetime.abort(/* @__PURE__ */ new Error("Terminal Session owner disposed"));
			owner.cleanup = (async () => {
				await Promise.allSettled(owner.pending.values());
				const errors = (await Promise.allSettled([...[...owner.terminals.values()].map((terminal) => terminal.dispose()), ...[...owner.allocations.values()].map((allocation) => allocation.cleanup.dispose())])).filter((result) => result.status === "rejected").map((result) => result.reason);
				if (errors.length > 0) throw new AggregateError(errors, "Session terminal cleanup failed");
				owner.terminals.clear();
				owner.allocations.clear();
				this.owners.delete(id);
			})().catch((error) => {
				delete owner.cleanup;
				throw error;
			});
			return owner.cleanup;
		}
		terminal(agent, id) {
			const terminal = this.owners.get(agent.id)?.terminals.get(id);
			if (terminal === void 0) throw new RemoteError("terminal/unavailable", "Terminal no longer exists in this Session", {});
			this.requireOpen(this.owners.get(agent.id), id);
			return terminal;
		}
		requireOpen(owner, id) {
			if (owner.closedIds.has(id)) throw new RemoteError("terminal/unavailable", "Terminal was closed in this Session", {});
		}
		dimensions(cols, rows) {
			if (!Number.isSafeInteger(cols) || cols < 2 || cols > this.config.maxCols || !Number.isSafeInteger(rows) || rows < 1 || rows > this.config.maxRows) throw new Error("Terminal dimensions exceed the configured limits");
		}
		execution(agent) {
			const subprocess = agent.ctx.get("subprocess");
			const sandboxPolicy = agent.ctx.get("sandboxPolicy");
			if (subprocess === void 0 || sandboxPolicy === void 0) throw new Error("The Session execution environment requires subprocess and sandbox policy providers");
			const workingDirectory = agent.ctx.get("workingDirectory");
			if (workingDirectory === void 0) throw new Error("The Session execution environment requires a working-directory provider");
			return {
				subprocess,
				sandboxPolicy,
				workingDirectory
			};
		}
		async spawn(agent, owner, request, signal) {
			const { subprocess, workingDirectory } = this.execution(agent);
			const cwd = await workingDirectory.ensure(agent, signal);
			const shell = request.shellPath === void 0 ? await resolveShell(subprocess, this.config.shell, signal) : (await this.shells(agent, signal)).find((candidate) => candidate.path === request.shellPath);
			if (shell === void 0) throw new Error("Selected shell is not available in this execution environment");
			const handle = await subprocess.spawnTerminal({
				argv: [shell.path, ...shell.args],
				cwd,
				cols: request.cols,
				rows: request.rows,
				terminalType: "xterm-256color",
				env: { DSH_SESSION_ID: agent.id },
				shellActivity: true,
				graceMs: this.config.disposeGraceMs,
				signal
			});
			const info = {
				id: request.id,
				shell,
				title: shell.name,
				cwd,
				cols: request.cols,
				rows: request.rows,
				state: "running",
				exitCode: null
			};
			try {
				signal.throwIfAborted();
				return new BrowserTerminal(handle, info, this.config.scrollback, this.config.maxBufferedBytes);
			} catch (error) {
				const cleanup = new TerminalRetention(this.config, handle.inspectActivity.bind(handle), async () => {
					owner.closedIds.add(request.id);
					await handle.terminate();
					owner.allocations.delete(request.id);
				}, (cleanupError) => {
					this.ctx.logger.error("Browser terminal allocation cleanup failed", cleanupError);
				});
				owner.allocations.set(request.id, {
					info: {
						...info,
						state: "failed",
						error: error instanceof Error ? error.message : String(error)
					},
					cleanup
				});
				try {
					await cleanup.close();
				} catch (cleanupError) {
					throw new AggregateError([error, cleanupError], "Terminal allocation cleanup failed");
				}
				throw error;
			}
		}
	};
})();
//#endregion
export { TerminalController, TerminalController as default };
