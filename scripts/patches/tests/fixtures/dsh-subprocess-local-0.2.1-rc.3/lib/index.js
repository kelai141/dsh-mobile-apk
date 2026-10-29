import { C as bindManagedProcess, D as createProcessInspector, E as validateSubprocessSpec, O as controlPipe, S as loadLinuxExecve, T as spawnSubprocess, _ as parseWindowsRunnerResult, c as runnerStdio, d as cleanupLinuxLaunchFiles, l as spawnRunnerInvocation, m as deserializeRunnerError, n as WINDOWS_RUNNER_SELECTION, o as runnerEnvironment, p as createLinuxLaunchFiles, s as runnerInvocationAvailable, u as targetEnvironment, w as childEnv, y as readLinuxStartupError } from "./runner-launch-B2zsQ1Dz.js";
import { logSpillFailure, prepareManagedProcessBinding } from "./output.js";
import { closeSync, constants, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { constants as constants$1, devNull, tmpdir, userInfo } from "node:os";
import { basename, delimiter, extname, isAbsolute, join, resolve } from "node:path";
import { createLazyRequire } from "@deepseek-ai/dsh-lazy-require";
import { SubprocessExecutableNotFoundError, SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import { execFile, spawn, spawnSync } from "node:child_process";
import { setTimeout as setTimeout$1 } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import { loadWin32ProcessBindings, probeCurrentTokenJobSupport } from "@deepseek-ai/dsh-win32-process";
import { Buffer } from "node:buffer";
import { PassThrough } from "node:stream";
//#region lib/types/linux-scope.js
/** Linux user-systemd scope launch and managed-range ownership. */
const SYSTEMCTL_TIMEOUT_MS = 5e3;
const SCOPE_INITIAL_POLL_INTERVAL_MS = 50;
const MISSING_UNIT = /\bunit\b[^\r\n]*(?:could not be found|not found|not loaded)/iu;
const LITERAL_ARGV_OPTION = "--expand-environment=no";
const LITERAL_ARGV_OPTION_REJECTED = /unrecognized option\b.*expand-environment/u;
const KILL_ALL_MEMBERS = "--kill-who=all";
/** Flags bit that /proc/net/unix sets on a listening socket (__SO_ACCEPTCON). */
const UNIX_SOCKET_ACCEPTING = 65536;
function managerEnvironment() {
	const environment = childEnv({ LC_ALL: "C" });
	delete environment.SYSTEMD_LOG_TARGET;
	return environment;
}
function quietSystemdEnvironment() {
	return childEnv({
		LC_ALL: "C",
		SYSTEMD_LOG_TARGET: "null"
	});
}
function querySystemctl(command, args) {
	return new Promise((resolveResult) => {
		execFile(command, [...args], {
			encoding: "utf8",
			env: managerEnvironment(),
			timeout: SYSTEMCTL_TIMEOUT_MS
		}, (error, stdout, stderr) => {
			const code = error === null ? 0 : error.code;
			resolveResult({
				status: typeof code === "number" ? code : null,
				stdout,
				stderr,
				...error === null ? {} : { error }
			});
		});
	});
}
function unitStem(prefix) {
	return `${prefix}-${String(process.pid)}-${randomBytes(6).toString("hex")}`;
}
function sleepWithAbort(delayMs, signal) {
	return setTimeout$1(delayMs, void 0, { signal });
}
/**
* Confirm this exact runner entry and libc execve binding without a probe mode.
* @param internals - optional runner and libc-binding seams used by tests.
* @returns whether the bootstrap can enter the final target.
*/
function probeLinuxBootstrap(internals = {}) {
	try {
		(internals.loadLinuxExecve ?? loadLinuxExecve)();
		const invocation = internals.runnerInvocation ?? (internals.resolveRunnerInvocation ?? spawnRunnerInvocation)();
		return (internals.runnerAvailable ?? runnerInvocationAvailable)(invocation);
	} catch {
		return false;
	}
}
/**
* Confirm current literal-argv transient-scope support before selecting native launch.
* @param internals - optional systemd command seams used by tests.
* @returns the options that keep target argv literal, or undefined when the user manager cannot create the scope.
*/
function probeLinuxScope(internals = {}) {
	const attempt = (literalArgv) => {
		const unitBase = unitStem("dsh-subprocess-probe");
		const result = (internals.spawnSync ?? spawnSync)(internals.systemdRun ?? "systemd-run", [
			"--user",
			"--scope",
			"--quiet",
			"--collect",
			...literalArgv,
			`--unit=${unitBase}`,
			"--",
			internals.systemctl ?? "systemctl",
			"--user",
			"show",
			`${unitBase}.scope`,
			"--property=ActiveState",
			"--value"
		], {
			encoding: "utf8",
			env: quietSystemdEnvironment(),
			stdio: [
				"ignore",
				"ignore",
				"pipe"
			],
			timeout: SYSTEMCTL_TIMEOUT_MS
		});
		return {
			created: result.error === void 0 && result.status === 0,
			stderr: result.stderr
		};
	};
	const current = attempt([LITERAL_ARGV_OPTION]);
	if (current.created) return [LITERAL_ARGV_OPTION];
	if (!LITERAL_ARGV_OPTION_REJECTED.test(current.stderr)) return void 0;
	return attempt([]).created ? [] : void 0;
}
/**
* Check every Linux native prerequisite on each call.
* @param internals - optional native capability seams used by tests.
* @returns the literal-argv scope options when Linux native containment is available, otherwise undefined.
*/
function probeLinuxNative(internals = {}) {
	return probeLinuxBootstrap(internals) ? probeLinuxScope(internals) : void 0;
}
/**
* Query the user manager once through systemctl.
* @param internals - optional systemctl seam used by tests.
* @returns whether the query succeeds.
*/
function probeLinuxManager(internals = {}) {
	const result = (internals.spawnSync ?? spawnSync)(internals.systemctl ?? "systemctl", [
		"--user",
		"show",
		"--property=Version",
		"--value"
	], {
		env: managerEnvironment(),
		stdio: "ignore",
		timeout: SYSTEMCTL_TIMEOUT_MS
	});
	return result.error === void 0 && result.status === 0;
}
/**
* Find the socket a process in this network namespace listens on at path. The kernel lists a
* bound socket only while a process holds it open, so a socket file that a stopped or crashed
* listener left behind does not count.
*/
function unixSocketListener(path, table) {
	let text;
	try {
		text = readFileSync(table, "utf8");
	} catch (_unreadableSocketTable) {
		return;
	}
	const suffix = ` ${path}`;
	for (const line of text.split("\n")) {
		if (!line.endsWith(suffix)) continue;
		const fields = line.trim().split(/\s+/u);
		if (fields.slice(7).join(" ") === path && (Number.parseInt(String(fields[3]), 16) & UNIX_SOCKET_ACCEPTING) !== 0) return String(fields[6]);
	}
}
/**
* Identify the user manager's listener on `$XDG_RUNTIME_DIR/systemd/private`, the socket
* `systemd-run --user` connects through.
* @param internals - optional socket-table seam used by tests.
* @returns the listening socket's inode from the kernel socket table, or undefined when
*   XDG_RUNTIME_DIR is unset or nothing in this network namespace listens there.
*/
function linuxManagerListener(internals = {}) {
	const runtimeDirectory = childEnv().XDG_RUNTIME_DIR;
	if (runtimeDirectory === void 0 || runtimeDirectory === "") return void 0;
	return unixSocketListener(join(runtimeDirectory, "systemd", "private"), internals.unixSocketTable ?? "/proc/net/unix");
}
/**
* Identify the systemd-run binary that scope launches resolve through PATH, so a package upgrade
* that replaces it triggers another probe of its literal-argv options.
* @param internals - optional systemd-run seam used by tests.
* @returns the device, inode, size, and modification time of the first match, or undefined when none resolves.
*/
function systemdRunIdentity(internals = {}) {
	const command = internals.systemdRun ?? "systemd-run";
	const candidates = command.includes("/") ? [command] : (childEnv().PATH ?? "").split(":").filter((directory) => directory !== "").map((directory) => join(directory, command));
	for (const candidate of candidates) {
		let stats;
		try {
			stats = statSync(candidate, { throwIfNoEntry: false });
		} catch (_unreadableCandidate) {
			continue;
		}
		if (stats?.isFile() === true) return `${String(stats.dev)}:${String(stats.ino)}:${String(stats.size)}:${String(stats.mtimeMs)}`;
	}
}
/**
* Confirm the user manager before a scope launch. A listener on its private socket confirms it
* without a child process; otherwise one systemctl query decides. A hung manager that still
* listens passes, and its scope launch fails with LinuxScopeNotStartedError.
* @param internals - optional socket-table and systemctl seams used by tests.
* @returns whether a scope launch can reach the user manager.
*/
function confirmLinuxManager(internals = {}) {
	return linuxManagerListener(internals) !== void 0 || probeLinuxManager(internals);
}
/** A scope launch whose bootstrap never consumed its launch request, so its target never ran. */
var LinuxScopeNotStartedError = class extends Error {
	name = "LinuxScopeNotStartedError";
};
var LinuxScopeStartup = class {
	files;
	kind;
	terminationSignals = /* @__PURE__ */ new Set();
	constructor(files, kind) {
		this.files = files;
		this.kind = kind;
	}
	resolveOutcome(outcome) {
		const startup = readLinuxStartupError(this.files.startupErrorPath);
		if (startup !== void 0) throw deserializeRunnerError(startup.error);
		if (existsSync(this.files.requestPath) && !(outcome.signal !== null && this.terminationSignals.has(outcome.signal))) throw new LinuxScopeNotStartedError(`${this.kind} scope exited before its bootstrap consumed the launch request; the provider probes native containment again before its next command`);
		return outcome;
	}
};
var SystemdScopeOwner = class {
	unit;
	startup;
	direct;
	systemctl;
	runSync;
	query;
	sleep;
	establishment = "pending";
	stopped = false;
	terminationRequested = false;
	observation;
	killFailure;
	directKillSettlement;
	wakeGeneration = 0;
	wakeWaiter;
	constructor(unit, startup, direct, systemctl, runSync, query, sleep) {
		this.unit = unit;
		this.startup = startup;
		this.direct = direct;
		this.systemctl = systemctl;
		this.runSync = runSync;
		this.query = query;
		this.sleep = sleep;
	}
	inspectTaskCount() {
		const result = this.runSync(this.systemctl, [
			"--user",
			"show",
			"--property=LoadState",
			"--property=ActiveState",
			"--property=TasksCurrent",
			this.unit
		], {
			encoding: "utf8",
			env: managerEnvironment(),
			timeout: SYSTEMCTL_TIMEOUT_MS
		});
		if (result.error !== void 0 || result.status !== 0 || typeof result.stdout !== "string") return void 0;
		const state = this.parseUnitState(result.stdout);
		return state.loadState === "loaded" && state.activeState === "active" ? state.tasksCurrent : void 0;
	}
	signal(signal) {
		if (this.stopped) return;
		this.terminationRequested = true;
		if (this.direct.running()) this.startup.terminationSignals.add(signal);
		this.observeRequestConsumption();
		const directFallbackRequired = this.establishment === "pending";
		let directSignalled = false;
		if (directFallbackRequired && this.direct.running()) directSignalled = this.direct.signal(signal);
		const result = this.runSync(this.systemctl, [
			"--user",
			"kill",
			KILL_ALL_MEMBERS,
			`--signal=${signal}`,
			this.unit
		], {
			encoding: "utf8",
			env: managerEnvironment(),
			timeout: SYSTEMCTL_TIMEOUT_MS
		});
		this.wakeObservation();
		if (result.error === void 0 && result.status === 0) {
			if (signal === "SIGKILL") {
				this.killFailure = void 0;
				this.directKillSettlement = void 0;
			}
			return;
		}
		if (!directFallbackRequired && this.direct.running()) directSignalled = this.direct.signal(signal);
		if (signal === "SIGKILL") {
			const output = `${result.stdout}\n${result.stderr}`;
			if (!MISSING_UNIT.test(output)) {
				this.killFailure = result.error ?? /* @__PURE__ */ new Error(`systemctl could not signal ${this.unit}: ${output.trim() || `exit ${String(result.status)}`}`);
				this.directKillSettlement = directSignalled ? this.direct.settled.then(() => {}, () => {}) : void 0;
			}
		}
	}
	terminateForHostExit() {
		if (this.stopped) return;
		try {
			if (this.direct.running()) this.direct.signal("SIGKILL");
		} catch {}
		try {
			this.runSync(this.systemctl, [
				"--user",
				"kill",
				KILL_ALL_MEMBERS,
				"--signal=SIGKILL",
				this.unit
			], {
				env: managerEnvironment(),
				stdio: "ignore",
				timeout: SYSTEMCTL_TIMEOUT_MS
			});
		} catch {}
	}
	observeRequestConsumption() {
		if (this.establishment === "pending" && !existsSync(this.startup.files.requestPath)) this.establishment = "established";
	}
	absentUnit() {
		this.observeRequestConsumption();
		if (this.establishment === "established") return false;
		if (!this.direct.running() && existsSync(this.startup.files.requestPath)) return false;
		if (this.killFailure !== void 0) throw this.killFailure;
		return true;
	}
	/**
	* Prove an active unit with no processes is the empty managed range rather
	* than a launch still placing its payload. systemd ends a scope only on the
	* populated-to-empty transition, so a payload killed before it entered the
	* cgroup leaves the unit active forever. A departed client cannot add another
	* payload; a consumed request proves the payload already entered the scope,
	* even while its direct-process exit notification is pending.
	*/
	emptyRange(tasksCurrent) {
		return this.terminationRequested && tasksCurrent === 0 && (!this.direct.running() || !existsSync(this.startup.files.requestPath));
	}
	/** Release a leftover empty scope so the transient unit is collected and cannot accumulate. */
	releaseEmptyRange() {
		try {
			this.runSync(this.systemctl, [
				"--user",
				"stop",
				this.unit
			], {
				env: managerEnvironment(),
				stdio: "ignore",
				timeout: SYSTEMCTL_TIMEOUT_MS
			});
		} catch {}
	}
	parseUnitState(stdout) {
		const values = /* @__PURE__ */ new Map();
		for (const line of stdout.split(/\r?\n/u)) {
			if (line === "") continue;
			const separator = line.indexOf("=");
			if (separator <= 0) throw new Error(`systemctl returned malformed state for ${this.unit}: ${JSON.stringify(stdout.trim())}`);
			const name = line.slice(0, separator);
			if (values.has(name)) throw new Error(`systemctl returned duplicate ${name} for ${this.unit}`);
			values.set(name, line.slice(separator + 1));
		}
		const loadState = values.get("LoadState");
		const activeState = values.get("ActiveState");
		const reportedTasks = values.get("TasksCurrent");
		const tasksCurrent = reportedTasks === "[not set]" ? void 0 : reportedTasks;
		if (values.size !== (reportedTasks === void 0 ? 2 : 3) || loadState === void 0 || activeState === void 0) throw new Error(`systemctl returned incomplete state for ${this.unit}: ${JSON.stringify(stdout.trim())}`);
		if (tasksCurrent !== void 0 && !/^\d+$/u.test(tasksCurrent)) throw new Error(`systemctl returned a non-numeric TasksCurrent for ${this.unit}: ${JSON.stringify(tasksCurrent)}`);
		return {
			loadState,
			activeState,
			tasksCurrent: tasksCurrent === void 0 ? void 0 : Number(tasksCurrent)
		};
	}
	async rangeActive() {
		this.observeRequestConsumption();
		const generation = this.wakeGeneration;
		const directRunning = this.direct.running();
		const result = await this.query(this.systemctl, [
			"--user",
			"show",
			this.unit,
			"--property=LoadState",
			"--property=ActiveState",
			"--property=TasksCurrent"
		]);
		if (generation !== this.wakeGeneration) return true;
		const output = `${result.stdout}\n${result.stderr}`;
		if (result.status === 0) {
			const { loadState, activeState, tasksCurrent } = this.parseUnitState(result.stdout);
			if (loadState === "not-found" && activeState === "inactive") return this.absentUnit();
			if (loadState !== "loaded") throw new Error(`systemctl returned unknown state for ${this.unit}: ${JSON.stringify({
				loadState,
				activeState
			})}`);
			this.establishment = "established";
			if (activeState === "inactive" || activeState === "failed") return false;
			if (![
				"active",
				"activating",
				"reloading",
				"deactivating"
			].includes(activeState)) throw new Error(`systemctl returned unknown ActiveState for ${this.unit}: ${JSON.stringify(activeState)}`);
			if (this.emptyRange(tasksCurrent)) {
				this.releaseEmptyRange();
				return false;
			}
			if (this.killFailure !== void 0) {
				if (directRunning && this.directKillSettlement !== void 0) {
					const settlement = this.directKillSettlement;
					this.directKillSettlement = void 0;
					await settlement;
					return this.rangeActive();
				}
				throw this.killFailure;
			}
			return true;
		}
		if (!MISSING_UNIT.test(output)) {
			if (result.error !== void 0) throw result.error;
			throw new Error(`systemctl could not read ${this.unit}: ${output.trim() || `exit ${String(result.status)}`}`);
		}
		return this.absentUnit();
	}
	wakeObservation() {
		this.wakeGeneration += 1;
		this.wakeWaiter?.resolve();
		this.wakeWaiter = void 0;
	}
	async waitForPoll(delayMs, generation) {
		if (generation !== this.wakeGeneration) return;
		const wake = Promise.withResolvers();
		const waiter = {
			generation,
			resolve: wake.resolve
		};
		const sleepController = new AbortController();
		this.wakeWaiter = waiter;
		try {
			await Promise.race([this.sleep(delayMs, sleepController.signal), wake.promise]);
		} finally {
			sleepController.abort();
			if (this.wakeWaiter === waiter) this.wakeWaiter = void 0;
		}
	}
	async waitForExit() {
		if (this.stopped) return;
		this.observation ??= (async () => {
			let pollIntervalMs = SCOPE_INITIAL_POLL_INTERVAL_MS;
			let generation = this.wakeGeneration;
			while (await this.rangeActive()) {
				await this.waitForPoll(pollIntervalMs, generation);
				generation = this.wakeGeneration;
				if (this.establishment === "established") pollIntervalMs = Math.min(pollIntervalMs * 2, SYSTEMCTL_TIMEOUT_MS);
			}
			this.stopped = true;
		})().catch((error) => {
			this.observation = void 0;
			throw error;
		});
		await this.observation;
	}
	cleanup() {
		cleanupLinuxLaunchFiles(this.startup.files);
	}
};
function scopeArgs(unitBase, literalArgv, invocation, argv) {
	return [
		"--user",
		"--scope",
		"--quiet",
		"--collect",
		...literalArgv,
		`--unit=${unitBase}`,
		"--",
		...invocation,
		"--",
		...argv
	];
}
function directOutcome(child, startup) {
	return new Promise((resolveOutcome, rejectOutcome) => {
		let settled = false;
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			rejectOutcome(error);
		});
		child.once("exit", (exitCode, signal) => {
			if (settled) return;
			settled = true;
			try {
				resolveOutcome(startup.resolveOutcome({
					exitCode,
					signal
				}));
			} catch (error) {
				rejectOutcome(error instanceof Error ? error : new Error(String(error)));
			}
		});
	});
}
/**
* Send a direct-process signal, distinguishing an absent PID from failed delivery.
* @param pid - owned direct-process identity whose exit notification can still be pending.
* @param send - platform signal operation; true means the signal was submitted.
* @returns whether the signal was submitted or the owned PID is already absent.
*/
function signalLinuxDirectProcess(pid, send) {
	try {
		if (send()) return true;
	} catch {}
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return error.code === "ESRCH";
	}
}
function signalChildGroup(child, signal) {
	let groupSignalled = false;
	try {
		groupSignalled = process.kill(-child.pid, signal);
	} catch {}
	if (groupSignalled && signal === "SIGTERM") return true;
	return signalLinuxDirectProcess(child.pid, () => process.kill(child.pid, signal));
}
/**
* Prepare one Linux PTY scope using the same launch request and bootstrap core.
* @param spec - terminal target request.
* @param targetEnv - validated complete target environment.
* @param literalArgv - options from the provider's positive scope probe.
* @param internals - optional runner and systemd seams used by tests.
* @returns invocation and ownership callbacks; requested termination preserves the observed signal even before bootstrap consumption.
*/
function prepareLinuxTerminalScope(spec, targetEnv, literalArgv, internals = {}) {
	const invocation = internals.runnerInvocation ?? spawnRunnerInvocation();
	const files = createLinuxLaunchFiles({
		cwd: spec.cwd,
		env: targetEnv
	});
	const startup = new LinuxScopeStartup(files, "terminal");
	const unitBase = unitStem("dsh-terminal");
	return {
		command: internals.systemdRun ?? "systemd-run",
		args: scopeArgs(unitBase, literalArgv, invocation, spec.argv),
		cwd: process.cwd(),
		env: runnerEnvironment(files.requestPath, invocation),
		bindOwner: (direct) => new SystemdScopeOwner(`${unitBase}.scope`, startup, direct, internals.systemctl ?? "systemctl", internals.spawnSync ?? spawnSync, internals.systemctlQuery ?? querySystemctl, internals.sleep ?? sleepWithAbort),
		resolveOutcome: (outcome) => startup.resolveOutcome(outcome),
		cleanup: () => {
			cleanupLinuxLaunchFiles(files);
		}
	};
}
/**
* Launch one ordinary target inside a transient user scope.
* @param spec - ordinary target request.
* @param targetEnv - validated complete target environment.
* @param literalArgv - options from the provider's positive scope probe.
* @param internals - optional runner and systemd seams used by tests.
* @returns streams, result, and scope owner; requested termination preserves the observed signal even before bootstrap consumption.
*/
function launchLinuxScope(spec, targetEnv, literalArgv, internals = {}) {
	const invocation = internals.runnerInvocation ?? spawnRunnerInvocation();
	const files = createLinuxLaunchFiles({
		cwd: spec.cwd,
		env: targetEnv,
		...spec.stdio.control === void 0 ? {} : { control: spec.stdio.control }
	});
	const startup = new LinuxScopeStartup(files, "subprocess");
	const unitBase = unitStem("dsh-subprocess");
	let child;
	try {
		child = (internals.spawn ?? spawn)(internals.systemdRun ?? "systemd-run", scopeArgs(unitBase, literalArgv, invocation, spec.argv), {
			cwd: process.cwd(),
			env: runnerEnvironment(files.requestPath, invocation),
			stdio: runnerStdio(spec, false),
			detached: true
		});
	} catch (error) {
		cleanupLinuxLaunchFiles(files);
		throw error;
	}
	const direct = directOutcome(child, startup);
	const owner = new SystemdScopeOwner(`${unitBase}.scope`, startup, {
		running: () => child.pid !== void 0 && child.exitCode === null && child.signalCode === null,
		signal: (signal) => signalChildGroup(child, signal),
		settled: direct
	}, internals.systemctl ?? "systemctl", internals.spawnSync ?? spawnSync, internals.systemctlQuery ?? querySystemctl, internals.sleep ?? sleepWithAbort);
	return {
		stdin: child.stdin,
		stdout: child.stdout,
		stderr: child.stderr,
		control: controlPipe(child, spec.stdio.control),
		direct,
		owner
	};
}
//#endregion
//#region lib/types/linux-scope-selector.js
/** Linux native containment decisions over injected host observations. */
/**
* Provider-lifetime Linux scope selection. A probe runs on the first selection and again only after
* a scope launch never started its target, a different user-manager listener appears under a
* negative verdict, or the systemd-run binary changes under a positive one. A positive verdict
* confirms the user manager on every selection. Selection is synchronous, so a decision stays
* valid for the launch that follows it.
*/
var LinuxScopeSelector = class {
	observe;
	state = {
		kind: "unprobed",
		trigger: "first"
	};
	generation = 0;
	/** @param observe - host checks consulted by each selection. */
	constructor(observe) {
		this.observe = observe;
	}
	/**
	* Choose containment for one eligible launch.
	* @returns the decision and the branch that produced it.
	*/
	select() {
		const state = this.state;
		if (state.kind === "unprobed") return this.probe(state.trigger);
		if (state.kind === "available") {
			if (this.observe.launcherIdentity() !== state.launcher) return this.probe("launcher-changed");
			return this.observe.confirmManager() ? {
				kind: "scope",
				reason: "manager-confirmed",
				literalArgv: state.literalArgv,
				generation: this.generation,
				probe: void 0
			} : {
				kind: "fallback",
				reason: "manager-unconfirmed",
				probe: void 0
			};
		}
		const listener = this.observe.managerListener();
		if (listener === void 0) return {
			kind: "fallback",
			reason: "no-listener",
			probe: void 0
		};
		if (listener === state.listener) return {
			kind: "fallback",
			reason: "same-listener",
			probe: void 0
		};
		return this.probe("new-listener");
	}
	/**
	* Record that a scope launched under generation exited before its bootstrap started the target,
	* so the next selection probes again. Launches from a superseded probe are ignored.
	* @param generation - generation of the scope decision that launched it.
	*/
	scopeNotStarted(generation) {
		if (generation === this.generation) this.state = {
			kind: "unprobed",
			trigger: "scope-not-started"
		};
	}
	probe(trigger) {
		this.generation += 1;
		const listener = this.observe.managerListener();
		const launcher = this.observe.launcherIdentity();
		const literalArgv = this.observe.probe();
		if (literalArgv === void 0) {
			this.state = {
				kind: "unavailable",
				listener
			};
			return {
				kind: "fallback",
				reason: "probe-unavailable",
				probe: trigger
			};
		}
		this.state = {
			kind: "available",
			literalArgv,
			launcher
		};
		return {
			kind: "scope",
			reason: "probe-available",
			literalArgv,
			generation: this.generation,
			probe: trigger
		};
	}
};
//#endregion
//#region lib/types/windows-job.js
/** Windows parent-side launch and ownership for the private Job runner. */
function isWindowsStartCancellationError(error) {
	return error.name === "Error" && error.message === "subprocess target start was cancelled" && error.code === void 0 && error.syscall === void 0 && error.path === void 0;
}
/**
* Re-check the runner entry, bindings, and current Job capability for every spawn.
* @param internals - optional runner and Win32 capability seams used by tests.
* @returns whether the Windows native containment path is currently available.
*/
function probeWindowsJob(internals = {}) {
	try {
		const invocation = internals.runnerInvocation ?? (internals.resolveRunnerInvocation ?? spawnRunnerInvocation)();
		if (!(internals.runnerAvailable ?? runnerInvocationAvailable)(invocation)) return false;
		const api = (internals.loadWin32ProcessBindings ?? loadWin32ProcessBindings)();
		(internals.probeCurrentTokenJobSupport ?? probeCurrentTokenJobSupport)(api);
		return true;
	} catch {
		return false;
	}
}
var WindowsJobOwner = class {
	runner;
	exited;
	directResultType;
	failInfrastructure;
	cancellationReason;
	cancellationReasonSet = false;
	terminationSent = false;
	constructor(runner, exited, directResultType, failInfrastructure) {
		this.runner = runner;
		this.exited = exited;
		this.directResultType = directResultType;
		this.failInfrastructure = failInfrastructure;
		this.exited.catch(() => {});
	}
	signal(_signal, cancellationReason) {
		if (!this.cancellationReasonSet) {
			this.cancellationReason = cancellationReason;
			this.cancellationReasonSet = true;
		}
		if (this.terminationSent || !this.runner.connected) return;
		this.terminationSent = true;
		try {
			this.runner.send?.({ type: "terminate" }, (error) => {
				if (error === null || this.directResultType() !== void 0) return;
				this.failInfrastructure(error);
				this.terminateForHostExit();
			});
		} catch (error) {
			this.failInfrastructure(error);
			this.terminateForHostExit();
		}
	}
	mapStartFailure(failure, serialized) {
		return this.cancellationReasonSet && isWindowsStartCancellationError(serialized) ? this.cancellationReason : failure;
	}
	async waitForExit() {
		await this.exited;
	}
	terminateForHostExit() {
		try {
			this.runner.kill("SIGKILL");
		} catch {}
	}
};
/**
* Launch one target through a runner that uniquely owns its Job handle.
* @param spec - ordinary target request.
* @param targetEnv - validated complete target environment.
* @param internals - optional runner launch seams used by tests.
* @returns direct streams, result, and runner-owned managed range.
*/
function launchWindowsJob(spec, targetEnv, internals = {}) {
	const invocation = internals.runnerInvocation ?? spawnRunnerInvocation();
	const [command, ...prefix] = invocation;
	const ignoredStdinFd = spec.stdio.stdin === "ignore" ? openSync(devNull, "r") : void 0;
	let child;
	try {
		child = (internals.spawn ?? spawn)(command, [
			...prefix,
			"--",
			...spec.argv
		], {
			cwd: process.cwd(),
			windowsHide: true,
			env: runnerEnvironment(WINDOWS_RUNNER_SELECTION, invocation),
			stdio: runnerStdio(spec, true, ignoredStdinFd ?? "pipe")
		});
	} finally {
		if (ignoredStdinFd !== void 0) closeSync(ignoredStdinFd);
	}
	const targetStdin = child.stdio[4];
	const direct = Promise.withResolvers();
	const rangeExit = Promise.withResolvers();
	let directResultType;
	let runnerSpawned = false;
	let runnerExit;
	let ipcDisconnected = false;
	const failInfrastructure = (error) => {
		direct.reject(error);
		rangeExit.reject(error);
	};
	const settleRange = () => {
		if (!runnerSpawned || runnerExit === void 0) return;
		const { exitCode, signal } = runnerExit;
		if (exitCode === 0 && signal === null) {
			if (directResultType !== void 0) {
				rangeExit.resolve();
				return;
			}
			if (!ipcDisconnected) return;
		}
		const status = signal !== null ? `signal ${signal}` : exitCode === null ? "without an exit status" : `exit code ${String(exitCode)}`;
		failInfrastructure(/* @__PURE__ */ new Error(`subprocess-local: Windows Job runner exited with ${status} before proving its managed range empty`));
	};
	const owner = new WindowsJobOwner(child, rangeExit.promise, () => directResultType, failInfrastructure);
	child.on("message", (value) => {
		if (directResultType !== void 0) {
			failInfrastructure(/* @__PURE__ */ new Error("subprocess-local: Windows runner emitted more than one direct result"));
			owner.terminateForHostExit();
			return;
		}
		let result;
		try {
			result = parseWindowsRunnerResult(value);
		} catch (error) {
			failInfrastructure(error);
			owner.terminateForHostExit();
			return;
		}
		directResultType = result.type;
		if (result.type === "target-exit") direct.resolve({
			exitCode: result.exitCode,
			signal: null
		});
		else direct.reject(owner.mapStartFailure(deserializeRunnerError(result.error), result.error));
		settleRange();
	});
	child.once("spawn", () => {
		runnerSpawned = true;
		try {
			if (child.send === void 0) throw new Error("subprocess-local: Windows runner has no IPC channel");
			child.send({
				type: "start",
				cwd: spec.cwd,
				env: targetEnv,
				...spec.stdio.control === void 0 ? {} : { control: spec.stdio.control }
			}, (error) => {
				if (error === null) return;
				failInfrastructure(error);
				owner.terminateForHostExit();
			});
		} catch (error) {
			failInfrastructure(error);
			owner.terminateForHostExit();
		}
	});
	child.once("error", (error) => {
		if (!runnerSpawned) {
			direct.reject(error);
			rangeExit.resolve();
			return;
		}
		failInfrastructure(error);
	});
	child.once("exit", (exitCode, signal) => {
		runnerExit = {
			exitCode,
			signal
		};
		settleRange();
	});
	child.once("disconnect", () => {
		ipcDisconnected = true;
		settleRange();
	});
	return {
		stdin: spec.stdio.stdin === "ignore" ? null : targetStdin,
		stdout: child.stdio[5],
		stderr: child.stdio[6],
		control: controlPipe(child, spec.stdio.control),
		direct: direct.promise,
		owner
	};
}
//#endregion
//#region lib/types/terminal.js
/** Local node-pty terminal-process implementation for the subprocess seam. */
function delay(ms, signal) {
	return new Promise((resolve) => {
		const finish = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal?.addEventListener("abort", finish, { once: true });
	});
}
async function raceWithDelay(operation, ms, timeout) {
	const controller = new AbortController();
	try {
		return await Promise.race([operation, delay(ms, controller.signal).then(() => timeout)]);
	} finally {
		controller.abort();
	}
}
function signalName(number) {
	if (number === void 0 || number === 0) return null;
	for (const [name, value] of Object.entries(constants$1.signals)) if (value === number) return name;
	return null;
}
/**
* A local terminal whose native managed range or fallback process-session
* ownership stays below the PTY backend.
* The seam's terminate() promise — no write, inspection, or signal in flight
* after settlement — holds here without operation tracking only because every
* handle call completes synchronously under the hood (node-pty write, ps-based
* inspection). A first genuinely asynchronous step in any handle call must add
* the tracking a remote provider needs.
*/
var LocalTerminalHandle = class {
	terminal;
	inspector;
	graceMs;
	platform;
	managedOwner;
	resolveManagedOutcome;
	shellActivity;
	onQuiescence;
	observeShellExit;
	pid;
	output = new PassThrough();
	done;
	outcome = Promise.withResolvers();
	dataDisposable;
	exitDisposable;
	cleanup;
	managedOwnerCleaned = false;
	exited = false;
	outputPaused = false;
	trackedDescendants = [];
	activityRevision = 0;
	activityKey = "";
	quiescent = false;
	managedRangeEmpty = false;
	/** The spawned shell's start identity; scans stop adopting members once the root pid no longer carries it. */
	rootIdentity;
	/**
	* @param terminal - allocated node-pty process.
	* @param inspector - platform process/session operations.
	* @param graceMs - TERM-to-KILL and exit-wait grace.
	* @param platform - host platform; defaults to the running platform, injectable for deterministic tests.
	*/
	constructor(terminal, inspector, graceMs, platform = process.platform, managedOwner, resolveManagedOutcome, shellActivity, onQuiescence, observeShellExit = false) {
		this.terminal = terminal;
		this.inspector = inspector;
		this.graceMs = graceMs;
		this.platform = platform;
		this.managedOwner = managedOwner;
		this.resolveManagedOutcome = resolveManagedOutcome;
		this.shellActivity = shellActivity;
		this.onQuiescence = onQuiescence;
		this.observeShellExit = observeShellExit;
		this.pid = terminal.pid;
		try {
			this.rootIdentity = inspector.snapshot().tree(this.pid).find((member) => member.pid === this.pid);
		} catch (_rootIdentityUnavailable) {
			this.rootIdentity = void 0;
		}
		this.done = this.outcome.promise;
		const resume = () => {
			if (!this.outputPaused) return;
			this.outputPaused = false;
			if (!this.exited) terminal.resume();
		};
		this.output.on("drain", resume);
		this.output.once("close", () => {
			this.output.off("drain", resume);
		});
		this.dataDisposable = terminal.onData((data) => {
			if (!this.output.write(Buffer.from(data, "utf8")) && this.cleanup === void 0 && !this.outputPaused) {
				this.outputPaused = true;
				terminal.pause();
			}
		});
		this.exitDisposable = terminal.onExit(({ exitCode, signal: exitSignal }) => {
			if (this.exited) return;
			this.exited = true;
			if (this.managedOwner !== void 0 && this.observeShellExit) this.managedOwner.waitForExit().then(() => {
				this.managedRangeEmpty = true;
			}).catch(() => {});
			this.output.end();
			const outcome = {
				exitCode: exitSignal === void 0 || exitSignal === 0 ? exitCode : null,
				signal: signalName(exitSignal)
			};
			try {
				this.outcome.resolve(this.resolveManagedOutcome?.(outcome) ?? outcome);
			} catch (error) {
				this.outcome.reject(error);
			}
		});
	}
	/** Whether node-pty has not yet published the top-level exit event. */
	get running() {
		return !this.exited;
	}
	async write(data) {
		if (this.exited) throw new Error("terminal process has exited");
		this.shellActivity?.invalidate();
		this.terminal.write(data);
	}
	async resize(cols, rows) {
		if (this.exited) throw new Error("terminal process has exited");
		this.terminal.resize(cols, rows);
	}
	async inspectForeground() {
		this.descendants(this.inspector.snapshot());
		const processGroupId = this.inspector.foregroundPgid(this.pid);
		if (processGroupId === void 0) return void 0;
		return {
			processGroupId,
			inputWaiting: this.inspector.isStdinWaiting(processGroupId, this.pid)
		};
	}
	async inspectActivity() {
		let state = this.quiescent ? "idle" : "unknown";
		let revision = 0;
		if (!this.quiescent) try {
			const shell = this.shellActivity?.inspect(this.pid) ?? {
				state: "unknown",
				revision: 0
			};
			revision = shell.revision;
			const observed = this.inspector.snapshot();
			const descendants = this.descendants(observed);
			const root = observed.tree(this.pid).find((member) => member.pid === this.pid);
			if (this.exited && this.managedRangeEmpty) state = "idle";
			else if (descendants.length > 0) state = "busy";
			else if (this.exited && this.managedOwner === void 0 && this.platform === "linux" && observed.complete === true && root === void 0) state = observed.session(this.pid).some((member) => observed.alive(member)) ? "busy" : "idle";
			else if (observed.complete === true && root?.started === this.rootIdentity?.started && root !== void 0) {
				const foreground = this.inspector.foregroundPgid(this.pid);
				state = foreground === void 0 ? "unknown" : foreground === this.pid ? shell.state : "busy";
				if (state === "idle" && this.managedOwner !== void 0) {
					const tasks = this.managedOwner.inspectTaskCount?.();
					state = tasks === void 0 || tasks < 1 ? "unknown" : tasks === 1 ? "idle" : "busy";
				}
			}
		} catch (_incompleteActivityObservation) {
			state = "unknown";
		}
		const key = `${revision}:${state}`;
		if (key !== this.activityKey) {
			this.activityKey = key;
			this.activityRevision++;
		}
		return {
			state,
			revision: this.activityRevision
		};
	}
	async signalForeground(signal) {
		this.shellActivity?.invalidate();
		const foreground = await this.inspectForeground();
		if (foreground === void 0) throw new Error(`cannot resolve foreground process group for terminal ${this.pid}`);
		if (signal === "SIGKILL" && foreground.processGroupId === this.pid) throw new Error("refusing to SIGKILL the terminal shell; terminate the terminal session instead");
		if (this.platform === "win32") {
			if (signal === "SIGINT") {
				this.terminal.write("");
				return foreground.processGroupId;
			}
			if (signal === "SIGTSTP" || signal === "SIGHUP") throw new Error(`signal ${signal} is unsupported on Windows; only SIGINT, SIGTERM, and SIGKILL are available`);
		}
		this.inspector.signalGroup(foreground.processGroupId, signal);
		return foreground.processGroupId;
	}
	terminate() {
		if (this.cleanup !== void 0) return this.cleanup;
		if (this.outputPaused) {
			this.outputPaused = false;
			this.terminal.resume();
		}
		const cleanup = this.closeOnce().then(() => {
			this.quiescent = true;
			this.shellActivity?.dispose();
			this.onQuiescence?.();
		});
		this.cleanup = cleanup;
		cleanup.catch(() => {
			this.cleanup = void 0;
		});
		return cleanup;
	}
	/**
	* Force-terminate the observable session synchronously during Node's exit
	* event. This does not claim quiescence and does not replace terminate().
	*/
	terminateForHostExit() {
		this.forceStopDescendants();
		this.forceStopShell();
		this.forceStopDescendants();
		this.managedOwner?.terminateForHostExit();
	}
	forceStopShell() {
		if (this.exited) return;
		if (this.rootIdentity !== void 0) {
			try {
				this.inspector.signalProcess(this.rootIdentity, "SIGKILL");
			} catch (_rootExitedDuringHostExit) {}
			return;
		}
		try {
			this.terminal.kill("SIGKILL");
		} catch (_unidentifiedShellExitedDuringHostExit) {}
	}
	survivors(members, observed) {
		return members.filter((member) => observed.alive(member));
	}
	descendants(observed) {
		const tree = observed.tree(this.pid);
		const root = tree.find((member) => member.pid === this.pid);
		const rootVerified = this.rootIdentity !== void 0 && root !== void 0 && root.started === this.rootIdentity.started;
		this.trackedDescendants = this.survivors(this.unionMembers(this.trackedDescendants, ...rootVerified ? [tree, observed.session(this.pid)] : []).filter((member) => member.pid !== this.pid), observed);
		return this.trackedDescendants;
	}
	async waitForMembers(members) {
		if (members.length === 0) return [];
		const until = Date.now() + this.graceMs;
		let survivors = this.survivors(members, this.inspector.snapshot());
		while (survivors.length > 0 && Date.now() < until) {
			await delay(Math.min(25, Math.max(1, until - Date.now())));
			survivors = this.survivors(members, this.inspector.snapshot());
		}
		return survivors;
	}
	signalMembers(members, signal) {
		for (const member of members) try {
			this.inspector.signalProcess(member, signal);
		} catch (_alreadyExitedDuringSignal) {}
	}
	forceStopDescendants() {
		let members = this.trackedDescendants;
		try {
			members = this.descendants(this.inspector.snapshot());
		} catch (_processTableUnavailableDuringHostExit) {}
		this.signalMembers(members, "SIGKILL");
	}
	unionMembers(...groups) {
		const members = [];
		const seen = /* @__PURE__ */ new Set();
		for (const group of groups) for (const member of group) {
			const key = `${member.pid}:${member.started}`;
			if (seen.has(key)) continue;
			seen.add(key);
			members.push(member);
		}
		return members;
	}
	async stopDescendants() {
		const captured = this.descendants(this.inspector.snapshot());
		this.signalMembers(captured, "SIGTERM");
		const capturedSurvivors = await this.waitForMembers(captured);
		const members = this.unionMembers(capturedSurvivors, this.descendants(this.inspector.snapshot()));
		this.signalMembers(members, "SIGKILL");
		const survivors = await this.waitForMembers(members);
		const observed = this.inspector.snapshot();
		return this.survivors(this.unionMembers(survivors, this.descendants(observed)), observed);
	}
	async stopShell() {
		if (this.platform === "win32") {
			await this.stopShellWindows();
			return;
		}
		if (!this.exited) {
			try {
				this.terminal.kill("SIGTERM");
			} catch (_topLevelAlreadyExitedDuringTerm) {}
			await Promise.race([this.done.then(() => void 0), delay(this.graceMs)]);
		}
		if (!this.exited) {
			try {
				this.terminal.kill("SIGKILL");
			} catch (_topLevelAlreadyExitedDuringKill) {}
			await Promise.race([this.done.then(() => void 0), delay(this.graceMs)]);
		}
		if (!this.exited) throw new Error(`terminal cleanup failed; surviving pid: ${this.pid}`);
	}
	async stopShellWindows() {
		const shellGone = () => this.exited || this.rootIdentity !== void 0 && !this.inspector.isAlive(this.rootIdentity);
		if (!shellGone() && this.rootIdentity !== void 0) {
			this.inspector.signalProcess(this.rootIdentity, "SIGTERM");
			await this.waitForWindowsShellExit();
		}
		if (!shellGone() && this.rootIdentity === void 0) {
			try {
				this.terminal.kill();
			} catch (_topLevelAlreadyExitedDuringKill) {}
			await Promise.race([this.done.then(() => void 0), delay(this.graceMs)]);
		}
		if (!shellGone() && this.rootIdentity !== void 0) {
			this.inspector.signalProcess(this.rootIdentity, "SIGKILL");
			await this.waitForWindowsShellExit();
		}
		if (!shellGone()) throw new Error(`terminal cleanup failed; surviving pid: ${this.pid}`);
	}
	async waitForWindowsShellExit() {
		const until = Date.now() + this.graceMs;
		while (!this.exited && Date.now() < until) {
			if (this.rootIdentity !== void 0 && !this.inspector.isAlive(this.rootIdentity)) return;
			await delay(Math.min(25, Math.max(1, until - Date.now())));
		}
	}
	async closeOnce() {
		if (this.managedOwner !== void 0) {
			try {
				await this.closeManagedRange(this.managedOwner);
				this.dataDisposable.dispose();
				this.exitDisposable.dispose();
			} finally {
				this.done.finally(() => {
					this.cleanupManagedOwner(this.managedOwner);
				}).catch(() => {});
			}
			return;
		}
		let survivors = await this.stopDescendants();
		if (survivors.length > 0) throw new Error(`terminal cleanup failed; surviving pids: ${survivors.map((member) => member.pid).join(", ")}`);
		await this.stopShell();
		survivors = await this.stopDescendants();
		if (survivors.length > 0) throw new Error(`terminal cleanup failed; surviving pids: ${survivors.map((member) => member.pid).join(", ")}`);
		this.settleExitIfGone();
		this.dataDisposable.dispose();
		this.exitDisposable.dispose();
	}
	cleanupManagedOwner(owner) {
		if (this.managedOwnerCleaned) return;
		this.managedOwnerCleaned = true;
		owner.cleanup?.();
	}
	async closeManagedRange(owner) {
		owner.signal("SIGTERM");
		const observation = owner.waitForExit();
		const first = await raceWithDelay(observation.then(() => ({ kind: "stopped" }), (error) => ({
			kind: "failed",
			error
		})), this.graceMs, { kind: "timeout" });
		if (first.kind !== "stopped") {
			owner.signal("SIGKILL");
			if (first.kind === "failed") {
				try {
					await owner.waitForExit();
				} catch (finalError) {
					throw new AggregateError([first.error, finalError], "terminal managed-range cleanup failed");
				}
				throw first.error;
			}
			await observation;
		}
		if (!this.exited) await raceWithDelay(this.done.then(() => void 0), this.graceMs, void 0);
		if (!this.exited) throw new Error(`terminal cleanup failed; surviving pid: ${this.pid}`);
	}
	settleExitIfGone() {
		if (this.platform !== "win32") return;
		if (this.exited) return;
		/* v8 ignore next -- stopShellWindows() verified the shell is gone or threw;
		the identity re-check is a defensive fence for a future caller. */
		if (this.rootIdentity !== void 0 && this.inspector.isAlive(this.rootIdentity)) return;
		this.exited = true;
		this.output.end();
		this.outcome.resolve({
			exitCode: null,
			signal: null
		});
	}
};
//#endregion
//#region lib/types/shell-activity.js
/** Private shell lifecycle files; ordinary output never authorizes terminal reclamation. */
function quote(value) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
/** Opt-in startup integration and revision tracking for one ordinary interactive shell. */
var ShellActivity = class {
	directory;
	argv;
	env;
	revision = 0;
	observed = "";
	invalidated;
	state = "unknown";
	/**
	* @param directory - private startup and status file directory.
	* @param argv - shell launch preserving supported user startup files.
	* @param env - environment with any temporary startup redirect.
	*/
	constructor(directory, argv, env) {
		this.directory = directory;
		this.argv = argv;
		this.env = env;
	}
	/** Invalidate prompt evidence before delivering input or a foreground signal. */
	invalidate() {
		this.invalidated = this.read();
		this.revision++;
		this.state = "unknown";
	}
	/**
	* Read the latest top-level shell transition, fenced against input since that transition.
	* @param pid - original shell process id.
	* @returns lifecycle evidence; process ownership must be checked separately.
	*/
	inspect(pid) {
		const record = this.read();
		if (record !== this.observed) {
			this.observed = record;
			this.revision++;
		}
		const match = /^(\d+):(\d+):(idle|busy)\n?$/u.exec(record);
		this.state = record === this.invalidated || match?.[1] !== String(pid) ? "unknown" : match[3];
		return {
			state: this.state,
			revision: this.revision
		};
	}
	/** Remove private startup and status files after process quiescence. */
	dispose() {
		rmSync(this.directory, {
			recursive: true,
			force: true
		});
	}
	read() {
		try {
			return readFileSync(join(this.directory, "state"), "utf8");
		} catch (_unavailableShellObservation) {
			return "";
		}
	}
};
/**
* Prepare optional Bash or Zsh integration for a plain, non-login interactive launch.
* @param spec - terminal request; custom arguments and wrapped executables remain unmodified.
* @param env - scrubbed target environment.
* @param platform - execution platform.
* @returns private integration, or undefined for unsupported launches.
*/
function prepareShellActivity(spec, env, platform) {
	if (spec.shellActivity !== true || platform === "win32" || spec.argv.length !== 2 || spec.argv[1] !== "-i") return void 0;
	const shell = basename(spec.argv[0]);
	if (shell !== "bash" && shell !== "zsh") return void 0;
	const directory = mkdtempSync(join(tmpdir(), "dsh-shell-"));
	const state = quote(join(directory, "state"));
	const guards = quote(join(directory, "guards"));
	try {
		if (shell === "bash") {
			const rc = join(directory, "bashrc");
			writeFileSync(rc, [
				"[[ ! -r ~/.bashrc ]] || builtin source ~/.bashrc",
				"if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )) && [[ ! $(declare -p PROMPT_COMMAND PS0 2>/dev/null) =~ declare\\ -[^[:space:]]*r ]]; then",
				"  __dsh_shell_pid=$BASHPID; __dsh_shell_sequence=0",
				"  __dsh_shell_idle() {",
				"    local result=$?",
				"    if [[ $BASHPID == \"$__dsh_shell_pid\" ]]; then",
				"      (( ++__dsh_shell_sequence ))",
				"      local activity=idle",
				`      builtin trap -p >| ${guards}`,
				`      [[ ! -s ${guards} ]] || activity=unknown`,
				`      builtin printf '%s:%s:%s\\n' "$BASHPID" "$__dsh_shell_sequence" "$activity" >| ${state}`,
				"    fi",
				"    return \"$result\"",
				"  }",
				"  if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == \"declare -a \"* ]]; then",
				"    PROMPT_COMMAND+=(__dsh_shell_idle)",
				"  else",
				"    PROMPT_COMMAND=\"${PROMPT_COMMAND}\"$'\\n'\"__dsh_shell_idle\"",
				"  fi",
				`  PS0+=${quote(`$(builtin printf '%s:%s:busy' "$__dsh_shell_pid" "$__dsh_shell_sequence" >| ${state})`)}`,
				"fi",
				""
			].join("\n"), {
				mode: 384,
				flag: "wx"
			});
			return new ShellActivity(directory, [
				spec.argv[0],
				"--rcfile",
				rc,
				"-i"
			], env);
		}
		writeFileSync(join(directory, ".zshenv"), [
			env.ZDOTDIR === void 0 ? "unset ZDOTDIR" : `ZDOTDIR=${quote(env.ZDOTDIR)}`,
			"[[ ! -r ${ZDOTDIR:-$HOME}/.zshenv ]] || builtin source \"${ZDOTDIR:-$HOME}/.zshenv\"",
			"typeset -g __dsh_shell_pid=$$ __dsh_shell_sequence=0",
			"__dsh_shell_activity() {",
			"  (( ZSH_SUBSHELL == 0 && $$ == __dsh_shell_pid )) || return",
			"  (( ++__dsh_shell_sequence ))",
			`  builtin printf '%s:%s:%s\\n' "$$" "$__dsh_shell_sequence" "$1" >| ${state}`,
			"  return 0",
			"}",
			"__dsh_shell_idle() {",
			`  { builtin trap; zle -F; } >| ${guards}`,
			"  if [[ $CONTEXT != start || -n $BUFFER ]]; then __dsh_shell_activity busy",
			`  elif [[ -s ${guards} || -n \${(k)functions[(I)TRAP*]} ]]; then __dsh_shell_activity unknown`,
			"  else __dsh_shell_activity idle; fi",
			"}",
			"__dsh_shell_busy() { __dsh_shell_activity busy }",
			"__dsh_shell_init() {",
			"  autoload -Uz add-zle-hook-widget add-zsh-hook",
			"  add-zle-hook-widget line-init __dsh_shell_idle",
			"  add-zle-hook-widget line-finish __dsh_shell_busy",
			"  add-zsh-hook preexec __dsh_shell_busy",
			"  precmd_functions=(${precmd_functions:#__dsh_shell_init})",
			"}",
			"typeset -ga precmd_functions",
			"precmd_functions+=(__dsh_shell_init)",
			""
		].join("\n"), {
			mode: 384,
			flag: "wx"
		});
		return new ShellActivity(directory, spec.argv, {
			...env,
			ZDOTDIR: directory
		});
	} catch (error) {
		rmSync(directory, {
			recursive: true,
			force: true
		});
		throw error;
	}
}
//#endregion
//#region lib/types/index.js
/**
* Local Service Provider for the subprocess capability seam. Each spawn owns a
* platform-selected managed range with the spec's per-stream stdio dispositions.
* Normal disposal terminates and joins live ranges; Node's synchronous exit
* phase force-stops any ranges the service still owns. It has no config: every
* disposition and limit arrives on the spec, so deployment-varying choices
* stay with the caller's config (the bash executor's, the LSP host's, …).
* @module @deepseek-ai/dsh-subprocess-local
*/
const requireNodePty = createLazyRequire("node-pty", import.meta.url);
/**
* Local subprocess service: platform-selected managed ranges, Node-shaped stdio
* dispositions (raw pipes, inherit, bounded tail-keep collection with spill
* files), credential-scrubbed environment, and provider-owned range signalling.
* POSIX paths stage TERM before KILL; Windows paths terminate immediately.
* JavaScript-observable host exit also performs synchronous final termination.
*/
var LocalSubprocessRuntime = class extends SubprocessRuntime {
	/** Live handles retained for normal disposal and synchronous host-exit finalization. */
	live = /* @__PURE__ */ new Set();
	/** Live terminals retained through normal quiescence or host-exit finalization. */
	terminals = /* @__PURE__ */ new Set();
	/** Caller endpoints retained until close, independently of managed process lifetime. */
	controlChannels = /* @__PURE__ */ new Set();
	/** Test hook: process, spill, and platform operations forwarded to spawnSubprocess. */
	internals = {};
	/** Provider-lifetime latch suppressing repeated weaker-containment warnings. */
	fallbackWarningIssued = false;
	/**
	* Linux native containment decisions. Each probe is a spawnSync that blocks the event loop and forks the
	* host, so the selector reruns it only after an event invalidates the previous verdict.
	*/
	linuxScope = new LinuxScopeSelector({
		probe: () => probeLinuxNative(),
		managerListener: () => linuxManagerListener(),
		confirmManager: () => confirmLinuxManager(),
		launcherIdentity: () => systemdRunIdentity()
	});
	/** Scope decision of the launch in progress; selectContainmentMode sets it immediately before the launch reads it. */
	linuxScopeDecision;
	/** Test hook for platform process inspection; production resolves lazily on terminal spawn. */
	terminalInspector;
	constructor(ctx) {
		super(ctx);
		ctx.effect(() => {
			const onHostExit = () => {
				this.terminateForHostExit();
			};
			process.prependListener("exit", onHostExit);
			return async () => {
				await this.disposeManagedProcesses();
				process.off("exit", onHostExit);
			};
		}, "local subprocess teardown");
	}
	/** Spill failures reach the plugin logger; the log line is the only trace of why a result has no spill path. */
	reportSpillFailure = logSpillFailure(this.ctx.logger, "subprocess-local");
	terminateForHostExit() {
		for (const handle of this.live) try {
			handle.terminateForHostExit();
		} catch (_ordinaryRangeTerminationFailed) {}
		for (const terminal of this.terminals) try {
			terminal.terminateForHostExit();
		} catch (_terminalTerminationFailed) {}
	}
	async disposeManagedProcesses() {
		const pending = [];
		for (const handle of this.live) {
			handle.terminate();
			pending.push(Promise.all([handle.done.catch(() => {}), handle.waitForExit()]).then(() => {
				this.live.delete(handle);
			}));
		}
		for (const terminal of this.terminals) pending.push(terminal.terminate().then(() => {
			this.terminals.delete(terminal);
		}));
		const outcomes = await Promise.allSettled(pending);
		await Promise.all([...this.controlChannels].map((control) => new Promise((resolveClose) => {
			control.once("close", () => {
				resolveClose();
			});
			control.destroy();
		})));
		this.controlChannels.clear();
		const failures = [];
		for (const outcome of outcomes) if (outcome.status === "rejected") failures.push(outcome.reason);
		if (failures.length > 0) this.terminateForHostExit();
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) throw new AggregateError(failures, "local subprocess teardown failed");
	}
	async resolveExecutable(command, env, signal) {
		if (command.length === 0) throw new Error("subprocess-local: executable must be non-empty");
		signal?.throwIfAborted();
		const environment = childEnv(env);
		const absolute = isAbsolute(command);
		if (!absolute && (command.includes("/") || process.platform === "win32" && command.includes("\\"))) throw new Error(`subprocess-local: command ${JSON.stringify(command)} is a relative path; use an absolute path or a bare PATH name`);
		const candidates = absolute ? [command] : this.executableCandidates(command, environment);
		for (const candidate of candidates) {
			signal?.throwIfAborted();
			try {
				if (!(await stat(candidate)).isFile()) continue;
				await access(candidate, constants.X_OK);
				signal?.throwIfAborted();
				return candidate;
			} catch {}
		}
		signal?.throwIfAborted();
		throw new SubprocessExecutableNotFoundError(absolute ? `subprocess-local: command ${JSON.stringify(command)} is not an executable file` : `subprocess-local: command ${JSON.stringify(command)} was not found on PATH`);
	}
	executableCandidates(command, env) {
		const path = environmentValue(env, "PATH") ?? "";
		const extensions = process.platform === "win32" && extname(command) === "" ? (environmentValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
		return path.split(delimiter).flatMap((directory) => extensions.map((extension) => resolve(process.cwd(), directory, command + extension)));
	}
	spawn(spec) {
		validateSubprocessSpec(spec);
		const env = targetEnvironment(spec);
		const containmentMode = this.selectContainmentMode("ordinary");
		let handle;
		const internals = {
			...this.internals,
			onSpillFailure: this.reportSpillFailure
		};
		if (containmentMode === "fallback") handle = spawnSubprocess(spec, internals);
		else {
			const binding = prepareManagedProcessBinding(internals);
			const linuxScope = containmentMode === "linux-scope" ? this.linuxScopeDecision : void 0;
			handle = bindManagedProcess(spec, linuxScope === void 0 ? launchWindowsJob(spec, env) : launchLinuxScope(spec, env, linuxScope.literalArgv), binding);
			if (linuxScope !== void 0) this.watchLinuxScopeStart(handle.done, linuxScope.generation);
		}
		this.live.add(handle);
		const control = handle.control;
		if (control !== void 0) {
			this.controlChannels.add(control);
			control.once("close", () => {
				this.controlChannels.delete(control);
			});
		}
		const release = () => handle.waitForExit().then(() => {
			this.live.delete(handle);
		});
		handle.done.then(release, release).catch(() => {});
		return handle;
	}
	/** Probe again before the next launch when a scope launched under generation never started its target. */
	watchLinuxScopeStart(done, generation) {
		done.catch((error) => {
			if (error instanceof LinuxScopeNotStartedError) this.linuxScope.scopeNotStarted(generation);
		});
	}
	selectContainmentMode(kind) {
		const platform = this.internals.platform ?? process.platform;
		let fallbackReason;
		if (platform === "linux") {
			const decision = this.linuxScope.select();
			const probe = decision.probe === void 0 ? "" : `, probed after ${decision.probe}`;
			this.ctx.logger.debug(`linux native containment: ${decision.kind} (${decision.reason}${probe})`);
			if (decision.kind === "scope") {
				this.linuxScopeDecision = decision;
				return "linux-scope";
			}
			fallbackReason = "the current user-systemd scope or private bootstrap is unavailable";
		}
		if (kind === "ordinary" && platform === "win32") {
			if (probeWindowsJob()) return "windows-job";
		}
		this.warnFallback(platform, kind, fallbackReason);
		return "fallback";
	}
	warnFallback(platform, kind, selectedReason) {
		if (this.fallbackWarningIssued) return;
		this.fallbackWarningIssued = true;
		const reason = selectedReason ?? (platform === "darwin" ? "macOS has no supported persistent process-range owner" : platform === "win32" ? kind === "terminal" ? "Windows ConPTY remains outside Job containment" : "the Win32 Job runner is unavailable" : `platform ${platform} has no native managed range`);
		this.ctx.logger.warn(`subprocess-local is using weaker process-tree containment because ${reason}; descendants that escape the process group or direct-parent tree are not guaranteed to terminate or delay waitForExit()`);
	}
	/** @inheritdoc */
	async terminalEnvironment(signal) {
		signal?.throwIfAborted();
		const platform = process.platform === "win32" ? "windows" : "posix";
		const defaultShell = platform === "windows" ? process.env.ComSpec || void 0 : process.env.SHELL || userInfo().shell || void 0;
		return {
			platform,
			...defaultShell === void 0 ? {} : { defaultShell }
		};
	}
	async spawnTerminal(spec) {
		const file = spec.argv[0];
		if (file === void 0 || file.length === 0) throw new Error("subprocess-local: terminal argv must contain a program");
		spec.signal?.throwIfAborted();
		const inspector = this.terminalInspector ?? createProcessInspector();
		const containmentMode = this.selectContainmentMode("terminal");
		const env = targetEnvironment(spec);
		const platform = this.internals.platform ?? process.platform;
		const activity = prepareShellActivity(spec, env, platform);
		const launch = activity === void 0 ? spec : {
			...spec,
			argv: activity.argv,
			env: activity.env
		};
		const options = {
			name: spec.terminalType,
			rows: spec.rows,
			cols: spec.cols,
			cwd: spec.cwd,
			env: {
				...activity?.env ?? env,
				TERM: spec.terminalType
			},
			...platform === "win32" ? { useConptyDll: true } : {}
		};
		const linuxScope = containmentMode === "linux-scope" ? this.linuxScopeDecision : void 0;
		let scope;
		let terminal;
		try {
			scope = linuxScope === void 0 ? void 0 : prepareLinuxTerminalScope(launch, {
				...activity?.env ?? env,
				PWD: spec.cwd,
				TERM: spec.terminalType
			}, linuxScope.literalArgv);
			if (scope !== void 0) {
				options.cwd = scope.cwd;
				options.env = scope.env;
			}
			terminal = requireNodePty().spawn(scope?.command ?? file, scope?.args ?? [...launch.argv.slice(1)], options);
		} catch (error) {
			scope?.cleanup();
			activity?.dispose();
			throw error;
		}
		let handle;
		const directSettlement = Promise.withResolvers();
		const owner = scope?.bindOwner({
			running: () => handle?.running ?? true,
			settled: directSettlement.promise,
			signal: (signal) => signalLinuxDirectProcess(terminal.pid, () => process.kill(terminal.pid, signal))
		});
		handle = new LocalTerminalHandle(terminal, inspector, spec.graceMs, platform, owner, scope?.resolveOutcome, activity, () => {
			this.terminals.delete(handle);
		}, spec.shellActivity === true);
		this.terminals.add(handle);
		if (linuxScope !== void 0) this.watchLinuxScopeStart(handle.done, linuxScope.generation);
		const release = async () => {
			directSettlement.resolve();
			if (spec.shellActivity === true) return;
			await handle.terminate();
			this.terminals.delete(handle);
		};
		handle.done.then(release, release).catch(() => {});
		return handle;
	}
};
/** Read a Windows environment key using the platform's case-insensitive semantics. */
function environmentValue(env, name) {
	const exact = env[name];
	if (exact !== void 0 || process.platform !== "win32") return exact;
	const normalized = name.toUpperCase();
	return Object.entries(env).find(([key]) => key.toUpperCase() === normalized)?.[1];
}
//#endregion
export { LocalSubprocessRuntime, LocalSubprocessRuntime as default };
