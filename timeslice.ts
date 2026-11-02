#!/usr/bin/env tsx
/*
 * timeslice: builds a video by slicing the (x, y, t) volume of an input video
 * with a tilted plane that sweeps through time.
 *
 * Usage:
 *   npx tsx timeslice.ts <input> <angleX> <angleY> [options]
 *
 * Requires ffmpeg and ffprobe on PATH.
 */
import { spawn, spawnSync, ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";

interface Options {
	input: string;
	angleX: number;
	angleY: number;
	output: string;
	speed: number;
	width?: number;
	crf: number;
	maxMemoryMB: number;
}

interface VideoInfo {
	width: number;
	height: number;
	fps: number;
	frames: number | undefined;
	duration: number | undefined;
}

const t0Clock = Date.now();
function log(msg: string): void {
	const s = ((Date.now() - t0Clock) / 1000).toFixed(1).padStart(7);
	console.log(`[${s}s] ${msg}`);
}

function usage(): never {
	console.error(
		`Usage: npx tsx timeslice.ts <video> <angleX 0-90> <angleY 0-90> [options]

Options:
  -o, --output <file>   Output file (default: <input>.slice-X<ax>-Y<ay>.mp4)
  -s, --speed <n>       Voxels (pixels / frames) the plane advances per output frame (default: 1).
                        At 1, one output frame corresponds to one input frame of travel.
  -w, --width <px>      Downscale input to this width before processing (saves memory)
  --crf <n>             x264 quality, lower is better (default: 18)
  --max-memory <MB>     Abort if the volume would exceed this size (default: 4096)
`
	);
	process.exit(1);
}

function parseArgs(argv: string[]): Options {
	const positional: string[] = [];
	const opts: Partial<Options> = {
		speed: 1,
		crf: 18,
		maxMemoryMB: 4096,
	};
	const num = (flag: string, v: string | undefined): number => {
		const n = Number(v);
		if (v === undefined || !Number.isFinite(n)) {
			console.error(`Invalid value for ${flag}: ${v}`);
			usage();
		}
		return n;
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		switch (a) {
			case "-o":
			case "--output":
				opts.output = argv[++i];
				break;
			case "-s":
			case "--speed":
				opts.speed = num(a, argv[++i]);
				break;
			case "-w":
			case "--width":
				opts.width = num(a, argv[++i]);
				break;
			case "--crf":
				opts.crf = num(a, argv[++i]);
				break;
			case "--max-memory":
				opts.maxMemoryMB = num(a, argv[++i]);
				break;
			case "-h":
			case "--help":
				usage();
				break;
			default:
				if (a.startsWith("-") && !/^-?\d/.test(a)) {
					console.error(`Unknown option: ${a}`);
					usage();
				}
				positional.push(a);
		}
	}
	if (positional.length !== 3) usage();
	const [input, ax, ay] = positional;
	const angleX = num("angle X", ax);
	const angleY = num("angle Y", ay);
	if (angleX < 0 || angleX > 90 || angleY < 0 || angleY > 90) {
		console.error("Angles must be between 0 and 90.");
		usage();
	}
	if (!(opts.speed! > 0)) {
		console.error("--speed must be > 0");
		usage();
	}
	if (opts.width !== undefined && !(opts.width >= 2)) {
		console.error("--width must be >= 2");
		usage();
	}
	const parsed = path.parse(input);
	return {
		input,
		angleX,
		angleY,
		output:
			opts.output ??
			path.join(
				parsed.dir,
				`${parsed.name}.slice-X${angleX}-Y${angleY}.mp4`
			),
		speed: opts.speed!,
		width: opts.width,
		crf: opts.crf!,
		maxMemoryMB: opts.maxMemoryMB!,
	};
}

function parseRate(r: string): number {
	const [n, d] = r.split("/").map(Number);
	return d ? n / d : n;
}

function probe(file: string): VideoInfo {
	const r = spawnSync(
		"ffprobe",
		[
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-show_entries",
			"stream=width,height,avg_frame_rate,r_frame_rate,nb_frames,duration",
			"-of",
			"json",
			file,
		],
		{ encoding: "utf8" }
	);
	if (r.error) throw new Error(`Could not run ffprobe: ${r.error.message}`);
	if (r.status !== 0) throw new Error(`ffprobe failed: ${r.stderr}`);
	const s = JSON.parse(r.stdout).streams?.[0];
	if (!s) throw new Error("No video stream found in input.");
	let fps = parseRate(s.avg_frame_rate ?? "0/0");
	if (!(fps > 0)) fps = parseRate(s.r_frame_rate ?? "0/0");
	if (!(fps > 0)) throw new Error("Could not determine input FPS.");
	const frames = Number(s.nb_frames) || undefined;
	const duration = Number(s.duration) || undefined;
	return { width: s.width, height: s.height, fps, frames, duration };
}

function waitExit(p: ChildProcess, name: string): Promise<void> {
	return new Promise((resolve, reject) => {
		p.on("error", (e) => reject(new Error(`${name}: ${e.message}`)));
		p.on("close", (code) =>
			code === 0 ? resolve() : reject(new Error(`${name} exited with code ${code}`))
		);
	});
}

function fmtBytes(n: number): string {
	if (n >= 1 << 30) return (n / (1 << 30)).toFixed(2) + " GiB";
	return (n / (1 << 20)).toFixed(1) + " MiB";
}

function fmtEta(sec: number): string {
	if (!Number.isFinite(sec)) return "?";
	const m = Math.floor(sec / 60);
	return m > 0 ? `${m}m${Math.round(sec % 60)}s` : `${sec.toFixed(0)}s`;
}

/** Decodes the whole video into one RGB24 Buffer per frame (the t axis of the volume). */
async function loadVolume(
	opts: Options,
	w: number,
	h: number,
	expectedFrames: number | undefined
): Promise<Buffer[]> {
	const frameSize = w * h * 3;
	const args = ["-v", "error", "-i", opts.input, "-map", "0:v:0", "-vsync", "0"];
	args.push("-vf", `scale=${w}:${h}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-");
	const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "inherit"] });
	const done = waitExit(ff, "ffmpeg (decode)");
	done.catch(() => undefined);

	const frames: Buffer[] = [];
	let cur = Buffer.allocUnsafe(frameSize);
	let filled = 0;
	let lastLog = 0;

	for await (const chunk of ff.stdout! as AsyncIterable<Buffer>) {
		let pos = 0;
		while (pos < chunk.length) {
			const n = Math.min(chunk.length - pos, frameSize - filled);
			chunk.copy(cur, filled, pos, pos + n);
			filled += n;
			pos += n;
			if (filled === frameSize) {
				frames.push(cur);
				cur = Buffer.allocUnsafe(frameSize);
				filled = 0;
				const now = Date.now();
				if (now - lastLog > 500) {
					lastLog = now;
					const pct = expectedFrames
						? ` (${((frames.length / expectedFrames) * 100).toFixed(1)}%)`
						: "";
					log(
						`Decoding: ${frames.length}${
							expectedFrames ? "/" + expectedFrames : ""
						} frames${pct}, volume ${fmtBytes(frames.length * frameSize)}`
					);
				}
			}
		}
	}
	await done;
	log(`Decoding done: ${frames.length} frames, volume ${fmtBytes(frames.length * frameSize)}`);
	return frames;
}

async function main(): Promise<void> {
	const opts = parseArgs(process.argv.slice(2));
	if (!existsSync(opts.input)) {
		console.error(`Input file not found: ${opts.input}`);
		process.exit(1);
	}

	log(`Input:  ${opts.input}`);
	log(`Output: ${opts.output}`);
	log(`Slice angles: X=${opts.angleX}°, Y=${opts.angleY}°`);

	log("Probing input video...");
	const info = probe(opts.input);
	log(
		`Input: ${info.width}x${info.height} @ ${info.fps.toFixed(3)} fps` +
			(info.frames ? `, ~${info.frames} frames` : "") +
			(info.duration ? `, ${info.duration.toFixed(2)}s` : "")
	);

	// Even dimensions are required by yuv420p
	let w = opts.width ? Math.round(opts.width) : info.width;
	let h = opts.width ? Math.round((info.height * w) / info.width) : info.height;
	w -= w % 2;
	h -= h % 2;
	if (w !== info.width || h !== info.height) log(`Working resolution: ${w}x${h}`);

	const estFrames = info.frames ?? (info.duration ? Math.round(info.duration * info.fps) : undefined);
	if (estFrames) {
		const estMB = (estFrames * w * h * 3) / (1 << 20);
		log(`Estimated volume size in memory: ${estMB.toFixed(0)} MiB`);
		if (estMB > opts.maxMemoryMB) {
			console.error(
				`Volume would need ~${estMB.toFixed(0)} MiB (limit ${opts.maxMemoryMB}). ` +
					`Use --width to downscale or raise --max-memory.`
			);
			process.exit(1);
		}
	}

	log("Step 1/2: building the 3D (x, y, t) pixel matrix...");
	const volume = await loadVolume(opts, w, h, estFrames);
	const T = volume.length;
	if (T < 2) throw new Error("Need at least 2 frames to build a time volume.");

	// The volume is a box of w x h x T voxels (1 pixel == 1 frame). Start from the plane axes
	// u=x, v=y, n=t (n is the direction the plane moves in), rotate them about the y axis by
	// angle X (X=90 swaps t and x), then about the rotated u axis by angle Y (Y=90 swaps t and y).
	const rx = (opts.angleX * Math.PI) / 180;
	const ry = (opts.angleY * Math.PI) / 180;
	const [sX, cX, sY, cY] = [Math.sin(rx), Math.cos(rx), Math.sin(ry), Math.cos(ry)];
	// Snap values that are zero up to floating point error so axis-aligned slices are exact
	const clean = (v: number) => (Math.abs(v) < 1e-12 ? 0 : v);
	const u = [clean(cX), 0, clean(sX)]; // (x, y, t) components
	const n1 = [clean(-sX), 0, clean(cX)];
	const v = [clean(sY * n1[0]), clean(cY), clean(sY * n1[2])];
	const nrm = [clean(cY * n1[0]), clean(-sY), clean(cY * n1[2])];

	// Extent of the box projected on each plane axis gives the output frame size and sweep length
	const dims = [w, h, T];
	const extent = (a: number[]) => a.reduce((s, c, i) => s + Math.abs(c) * dims[i], 0);
	const even = (n: number) => Math.max(2, 2 * Math.ceil(Math.round(n * 1e6) / 1e6 / 2));
	const outW = even(extent(u));
	const outH = even(extent(v));
	const step = opts.speed;
	const outFrames = Math.max(1, Math.ceil(Math.round(extent(nrm) * 1e6) / 1e6 / step));
	const fmt = (a: number[]) => `(${a.map((c) => c.toFixed(3)).join(", ")})`;
	log(`Plane axes in (x, y, t): u=${fmt(u)}, v=${fmt(v)}, normal=${fmt(nrm)}`);
	log(
		`Output: ${outW}x${outH}, ${outFrames} frames @ ${info.fps.toFixed(3)} fps ` +
			`(${(outFrames / info.fps).toFixed(2)}s); plane advances ${step} voxel(s) per frame`
	);
	log(`Step 2/2: rendering ${outFrames} output frames...`);

	const enc = spawn(
		"ffmpeg",
		[
			"-v", "error", "-y",
			"-f", "rawvideo", "-pix_fmt", "rgb24",
			"-s", `${outW}x${outH}`, "-r", String(info.fps), "-i", "-",
			"-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", String(opts.crf),
			"-movflags", "+faststart",
			opts.output,
		],
		{ stdio: ["pipe", "inherit", "inherit"] }
	);
	const encDone = waitExit(enc, "ffmpeg (encode)");
	encDone.catch(() => undefined);
	const stdin = enc.stdin!;
	stdin.on("error", () => undefined); // surfaced through encDone

	const frameSize = outW * outH * 3;
	const renderStart = Date.now();
	let lastLog = 0;

	const [cx, cy, ct] = [(w - 1) / 2, (h - 1) / 2, (T - 1) / 2];
	const lastX = w - 1;
	const lastY = h - 1;
	const lastT = T - 1;

	for (let f = 0; f < outFrames; f++) {
		// A fresh buffer per frame: the pipe may still hold a reference to the previous one
		const out = Buffer.allocUnsafe(frameSize);
		const s = (f - (outFrames - 1) / 2) * step;
		let p = 0;
		for (let j = 0; j < outH; j++) {
			const dv = j - (outH - 1) / 2;
			const di = -(outW - 1) / 2;
			// Position in the volume of the first pixel of this row
			let px = cx + di * u[0] + dv * v[0] + s * nrm[0];
			let py = cy + di * u[1] + dv * v[1] + s * nrm[1];
			let pt = ct + di * u[2] + dv * v[2] + s * nrm[2];
			for (let i = 0; i < outW; i++, p += 3, px += u[0], py += u[1], pt += u[2]) {
				if (px < -0.5 || px > w - 0.5 || py < -0.5 || py > h - 0.5 || pt < -0.5 || pt > T - 0.5) {
					out[p] = out[p + 1] = out[p + 2] = 0;
					continue;
				}
				const qx = px < 0 ? 0 : px > lastX ? lastX : px;
				const qy = py < 0 ? 0 : py > lastY ? lastY : py;
				const qt = pt < 0 ? 0 : pt > lastT ? lastT : pt;
				const x0 = Math.floor(qx);
				const y0 = Math.floor(qy);
				const t0 = Math.floor(qt);
				const fx = qx - x0;
				const fy = qy - y0;
				const ft = qt - t0;
				const x1 = x0 < lastX ? x0 + 1 : x0;
				const y1 = y0 < lastY ? y0 + 1 : y0;
				const a = volume[t0];
				const b = volume[t0 < lastT ? t0 + 1 : t0];
				const o00 = (y0 * w + x0) * 3;
				const o10 = (y0 * w + x1) * 3;
				const o01 = (y1 * w + x0) * 3;
				const o11 = (y1 * w + x1) * 3;
				const w00 = (1 - fx) * (1 - fy);
				const w10 = fx * (1 - fy);
				const w01 = (1 - fx) * fy;
				const w11 = fx * fy;
				const gt = 1 - ft;
				for (let c = 0; c < 3; c++) {
					const va = a[o00 + c] * w00 + a[o10 + c] * w10 + a[o01 + c] * w01 + a[o11 + c] * w11;
					const vb = b[o00 + c] * w00 + b[o10 + c] * w10 + b[o01 + c] * w01 + b[o11 + c] * w11;
					out[p + c] = va * gt + vb * ft;
				}
			}
		}
		if (!stdin.write(out)) {
			// encDone rejects if the encoder dies, which would otherwise leave us waiting forever
			await Promise.race([new Promise<void>((r) => stdin.once("drain", () => r())), encDone]);
		}
		const now = Date.now();
		if (now - lastLog > 500 || f === outFrames - 1) {
			lastLog = now;
			const elapsed = (now - renderStart) / 1000;
			const rate = (f + 1) / elapsed;
			log(
				`Rendering: frame ${f + 1}/${outFrames} (${(((f + 1) / outFrames) * 100).toFixed(1)}%), ` +
					`${rate.toFixed(1)} fps, ETA ${fmtEta((outFrames - f - 1) / rate)}`
			);
		}
	}

	log("Finalizing: flushing and closing the encoder...");
	stdin.end();
	await encDone;
	log(`Done. Wrote ${outFrames} frames to ${opts.output} (${((Date.now() - t0Clock) / 1000).toFixed(1)}s total)`);
}

main().catch((e) => {
	console.error(`Error: ${e instanceof Error ? e.message : e}`);
	process.exit(1);
});
