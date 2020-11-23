const config = require('./config'),
    child_process = require('child_process'),
    etc = require('../etc'),
    { Muggle } = etc,
    imagerDb = require('./db'),
    index = require('./'),
    { is_standalone } = index,
    formidable = require('formidable'),
    fs = require('fs'),
    jobs = require('./jobs'),
    path = require('path'),
    urlParse = require('url').parse,
    winston = require('winston');

const IMAGE_EXTS = ['.png', '.jpg', '.gif'];
if (config.VIDEO && !config.DAEMON) {
	console.warn("Please enable imager.config.DAEMON security.");
}

function new_upload(req, resp) {
	const upload = new ImageUpload;
	upload.handle_request(req, resp);
}
exports.new_upload = new_upload;

function get_thumb_specs(image, scale) {
	const { ext, pinky } = image;
	const [w, h] = image.dims;
	const bound = config[pinky ? 'PINKY_DIMENSIONS' : 'THUMB_DIMENSIONS'];
	const r = Math.max(w / bound[0], h / bound[1], 1);
	const dims = [Math.round(w/r) * scale, Math.round(h/r) * scale];

	let bg, quality, format = 'jpg';
	// Note: WebMs pretend to be PNGs at this step,
	//       but those don't need transparent backgrounds.
	//       (well... WebMs *can* have alpha channels...)
	const isPNG = ext === '.png' && !image.video;
	if (config.PNG_THUMBS && (isPNG || ext == '.gif')) {
		format = 'png';
		quality = config.PNG_THUMB_QUALITY;
	}
	else if (pinky) {
		bg = '#ffffff';
		quality = config.PINKY_QUALITY;
	}
	else {
		bg = '#ffffff';
		quality = config.THUMB_QUALITY;
	}
	return {bound, bg, dims, ext, format, quality};
}

function ImageUpload(client_id) {
	this.db = new imagerDb.Onegai;
	this.client_id = client_id;
}

const IU = ImageUpload.prototype;

const validFields = ['spoiler', 'op'];

IU.status = function (msg) {
	this.client_call('status', msg);
};

IU.client_call = function (t, msg) {
	this.db.client_message(this.client_id, {t, arg: msg});
};

IU.respond = function (code, msg) {
	if (!this.resp)
		return;
	const origin = config.MAIN_SERVER_ORIGIN;
	this.resp.writeHead(code, {
		'Content-Type': 'text/html; charset=UTF-8',
		'Access-Control-Allow-Origin': origin,
	});
	this.resp.end(`<!doctype html><title>Upload result</title>
This is a legitimate imager response.
<script>
parent.postMessage(${etc.json_paranoid(msg)}, ${etc.json_paranoid(origin)});
</script>
`);
	this.resp = null;
};

IU.handle_request = function (req, resp) {
	if (req.method.toLowerCase() != 'post') {
		resp.writeHead(405, {Allow: 'POST'});
		resp.end();
		return;
	}
	this.resp = resp;
	const query = req.query || urlParse(req.url, true).query;
	this.client_id = parseInt(query.id, 10);
	if (!this.client_id || this.client_id < 1) {
		this.respond(400, "Bad client ID.");
		return;
	}

	const len = parseInt(req.headers['content-length'], 10);
	if (len > 0 && len > config.IMAGE_FILESIZE_MAX + (20*1024))
		return this.failure(Muggle('File is too large.'));

	const form = new formidable.IncomingForm({
		uploadDir: config.MEDIA_DIRS.tmp,
		maxFieldsSize: 50 * 1024,
		hash: 'md5',
	});
	form.onPart = function (part) {
		if (part.filename && part.name == 'image')
			form.handlePart(part);
		else if (!part.filename && validFields.indexOf(part.name) >= 0)
			form.handlePart(part);
	};
	form.once('error', err => this.failure(Muggle('Upload request problem.', err)));
	form.once('aborted', err => this.failure(Muggle('Upload was aborted.', err)));
	this.lastProgress = 0;
	form.on('progress', this.upload_progress_status.bind(this));

	try {
		form.parse(req, async (err, fields, files) => {
			if (err)
				return this.failure(Muggle('Invalid upload.', err));
			try {
				// from here on in, we are async and can simply throw errors,
				// rather than calling this.failure
				if (!files.image)
					throw Muggle('No image.');
				// copy only the info we're interested in
				// (skip `type` key; we'll just use the extension)
				const { size, path, name, hash } = files.image;
				const image = { size, path, name, hash };
				// kick off the whole pipeline!
				await this.parse_form(fields, image);
			}
			catch (e) {
				return this.failure(e);
			}
		});
	}
	catch (err) {
		this.failure(err);
	}
};

IU.upload_progress_status = function (received, total) {
	const percent = Math.floor(100 * received / total);
	const increment = (total > (512 * 1024)) ? 10 : 25;
	const quantized = Math.floor(percent / increment) * increment;
	if (quantized > this.lastProgress) {
		this.status(`${percent}% received...`);
		this.lastProgress = quantized;
	}
};

IU.parse_form = async function (fields, image) {
	this.image = image;
	image.pinky = !!parseInt(fields.op, 10);

	const spoiler = parseInt(fields.spoiler, 10);
	if (spoiler) {
		const { normal, trans } = config.SPOILER_IMAGES;
		if (!normal.includes(spoiler) && !trans.includes(spoiler))
			throw Muggle('Bad spoiler.');
		image.spoiler = spoiler;
	}

	image.MD5 = index.squish_MD5(image.hash);
	image.hash = null;

	try {
		await this.db.track_temporary(image.path);
	}
	catch (err) {
		winston.warn("Temp tracking error: " + err);
	}

	// okay process the image
	const filename = image.filename || image.name;
	image.ext = path.extname(filename).toLowerCase();
	if (image.ext == '.jpeg')
		image.ext = '.jpg';
	if (image.ext == '.mov')
		image.ext = '.mp4';
	const { ext } = image;

	const isVideoExt = config.VIDEO_EXTS.includes(ext);
	if (!IMAGE_EXTS.includes(ext) && (!config.VIDEO || !isVideoExt))
		throw Muggle('Invalid image format.');
	image.imgnm = filename.substr(0, 256);

	this.status('Verifying...');
	if (isVideoExt) {
		const result = await jobs.schedule(new StillJob(image.path, ext));
		await this.verify_video(result);
	}
	else if (ext == '.jpg' && jpegtranBin && jheadBin) {
		await jobs.schedule(new AutoRotateJob(image.path));
		await this.verify_image();
	}
	else
		await this.verify_image();
};

class AutoRotateJob extends jobs.Job {
	constructor(src) {
		super();
		this.src = src;
	}
	toString() { return `[jhead+jpegtran auto rotation of ${this.src}]`; }

	async perform_job() {
		try {
			await etc.execFile(jheadBin, ['-autorot', this.src]);
		}
		catch (err) {
			// if it failed, keep calm and thumbnail on
			winston.warn(`jhead: ${stderr || err}`);
		}
	}
}

class StillJob extends jobs.Job {
constructor(src, ext) {
	super();
	this.src = src;
	this.ext = ext;
}
toString() { return `[FFmpeg video still of ${this.src}]`; }

async perform_job() {
	const still = `still_${etc.random_id()}`;
	const dest = index.media_path('tmp', still);
	const args = ['-hide_banner', '-loglevel', 'info',
			'-i', this.src,
			'-f', 'image2', '-vf', 'thumbnail', '-vframes', '1', '-vcodec', 'png',
			'-y', dest];
	const opts = {env: {AV_LOG_FORCE_NOCOLOR: '1'}};
	let output;
	try {
		const { stderr } = await etc.execFile(ffmpegBin, args, opts);
		output = stderr;
	}
	catch (err) {
		const lines = err.stderr ? err.stderr.split('\n') : [];
		const first = lines[0];
		let msg;
		{
			if (/no such file or directory/i.test(first))
				msg = "Video went missing.";
			else if (/invalid data found when/i.test(first))
				msg = "Invalid video file.";
			else if (/^ffmpeg version/i.test(first))
				msg = "Server's ffmpeg is too old.";
			else {
				msg = "Unknown video reading error.";
				winston.warn("Unknown ffmpeg output: "+first);
			}
		}
		try {
			await etc.unlink(dest);
		}
		catch (e) { /* ignore unlink error if any, it's just cleanup */ }
		throw Muggle(msg, err);
	}

	// ok, parse the ffmpeg output
	const lines = output ? output.split('\n') : [];
	const first = lines[0];
	try {
		const { has_audio, duration } = this.test_format(first, output);
		return { has_audio, duration, still_path: dest };
	}
	catch (err) {
		try {
			await etc.unlink(dest);
		}
		catch (e) { /* ignored */ }
		throw err;
	}
}

test_format(first, full) {
	/* Could have false positives due to chapter titles. Bah. */
	const has_audio = /stream\s*#0.*audio:/i.test(full);
	/* Spoofable? */
	let dur = /duration: (\d\d):(\d\d):(\d\d)/i.exec(full);
	if (dur) {
		const m = parseInt(dur[2], 10), s = parseInt(dur[3], 10);
		if (dur[1] != '00' || m > 2)
			throw Muggle('Video exceeds 3 minutes.');
		dur = `${m ? m + 'm' : ''}${s}s`;
		if (dur == '0s')
			dur = '1s';
	}
	else {
		winston.warn("Could not parse duration:\n" + full);
	}

	if (/stream #1/i.test(full))
		throw Muggle('Video contains more than one stream.');

	if (this.ext == '.webm') {
		if (!/matroska,webm/i.test(first))
			throw Muggle('Video stream is not WebM.');
		return { has_audio, duration: dur };
	}
	else if (this.ext == '.mp4') {
		if (!/mp4,/i.test(first))
			throw Muggle('Video stream is not mp4.');
		return { has_audio, duration: dur };
	}
	else {
		throw Muggle('Unsupported video format.');
	}
}
} // StillJob end

IU.verify_video = async function (still_result) {
	const { has_audio, duration, still_path } = still_result;
	try {
		await this.db.track_temporary(still_path);
	} catch (err) {
		winston.warn(`Tracking error: ${err}`);
	}

	if (has_audio && !config.AUDIO)
		throw Muggle('Audio is not allowed.');

	// pretend it's a PNG for the next steps
	const { image } = this;
	image.video = image.ext.replace('.', '');
	image.video_path = image.path;
	image.path = still_path;
	image.ext = '.png';
	if (has_audio) {
		image.audio = true;
		if (config.AUDIO_SPOILER)
			image.spoiler = config.AUDIO_SPOILER;
	}
	if (duration)
		image.duration = duration;

	await this.verify_image();
};

IU.verify_image = async function () {
	const { image } = this;
	if (!image.path) {
		winston.error(`image missing path: ${JSON.stringify(image)}`);
		throw Muggle('Image was lost?!');
	}
	const tagged_path = `${image.ext.replace('.', '')}:${image.path}`;
	const checks = [
		identify(tagged_path),
	];
	if (image.ext == '.png' && !image.video)
		checks.push(detect_APNG(image.path));

	try {
		const [dims, apng] = await Promise.all(checks);
		image.dims = [dims.width, dims.height];
		if (apng)
			image.apng = 1;
	}
	catch (err) {
		throw Muggle('Wrong image type.', err);
	}

	// this used to be the start of method `verified`
	if (this.failed)
		return;

	const desc = image.video ? 'Video' : 'Image';
	const [w, h] = image.dims;
	if (!w || !h)
		throw Muggle('Bad image dimensions.');
	if (config.IMAGE_PIXELS_MAX && w * h > config.IMAGE_PIXELS_MAX)
		throw Muggle('Way too many pixels.');
	if (w > config.IMAGE_WIDTH_MAX && h > config.IMAGE_HEIGHT_MAX)
		throw Muggle(`${desc} is too wide and too tall.`);
	if (w > config.IMAGE_WIDTH_MAX)
		throw Muggle(`${desc} is too wide.`);
	if (h > config.IMAGE_HEIGHT_MAX)
		throw Muggle(`${desc} is too tall.`);

	const hash = await perceptual_hash(tagged_path, image);	
	await this.db.check_duplicate(hash);
	image.hash = hash;

	await this.deduped(tagged_path);
};

IU.deduped = async function (tagged_path) {
	const { image } = this;
	const specs = get_thumb_specs(image, 1);
	const [w, h] = image.dims;

	/* Determine whether we really need a thumbnail */
	let sp = image.spoiler;
	if (!sp && image.size < 30*1024
			&& ['.jpg', '.png'].includes(image.ext)
			&& !image.apng && !image.video
			&& w <= specs.dims[0] && h <= specs.dims[1]) {
		await this.got_nails();
		return;
	}
	image.thumb_path = `${image.path}_thumb`;
	specs.src = tagged_path;
	specs.dest = image.thumb_path;

	// was a composited spoiler selected or forced?
	if (image.audio && config.AUDIO_SPOILER)
		specs.comp = specs.overlay = true;
	if (sp && config.SPOILER_IMAGES.trans.includes(sp))
		specs.comp = true;

	if (specs.comp) {
		this.status(specs.overlay ? 'Overlaying...' : 'Spoilering...');
		const comp = composite_src(sp, image.pinky);
		image.comp_path = `${image.path}_comp`;
		specs.compDims = specs.overlay ? specs.dims : specs.bound;
		image.dims = [w, h].concat(specs.compDims);
		specs.composite = comp;
		specs.compDest = image.comp_path;

		await Promise.all([
			this.resize_and_track(specs, false),
			this.resize_and_track(specs, true),
		]);
	}
	else {
		image.dims = [w, h].concat(specs.dims);
		if (!sp)
			this.status('Thumbnailing...');

		const promises = [this.resize_and_track(specs, false)];

		if (config.EXTRA_MID_THUMBNAILS) {
			const specs = get_thumb_specs(image, 2);
			image.mid_path = `${image.path}_mid`;
			specs.src = tagged_path;
			specs.dest = image.mid_path;
			promises.push(this.resize_and_track(specs, false));
		}

		await Promise.all(promises);
	}
	await this.got_nails();
};

IU.got_nails = async function () {
	const { image } = this;
	if (image.video_path) {
		// stop pretending this is just a still image
		image.path = image.video_path;
		image.ext = '.' + image.video;
		delete image.video_path;
		// TODO shouldn't we delete the video still here?
	}

	const time = Date.now();
	image.src = time + image.ext;
	const base = path.basename;
	const tmps = {src: base(image.path)};

	if (image.thumb_path) {
		image.thumb = time + '.jpg';
		tmps.thumb = base(image.thumb_path);
	}
	if (image.mid_path) {
		image.mid = time + '.jpg';
		tmps.mid = base(image.mid_path);
	}
	if (image.comp_path) {
		image.composite = `${time}s${image.spoiler}.jpg`;
		tmps.comp = base(image.comp_path);
		delete image.spoiler;
	}

	await this.record_image(tmps);
};

function composite_src(spoiler, pinky) {
	const file = `spoiler${pinky ? 's' : ''}${spoiler}.png`;
	return path.join(config.SPOILER_DIR, file);
}

function which(name, callback, graceful) {
	child_process.exec('which ' + name, (err, stdout, stderr) => {
		if (err) {
			if (!graceful)
				throw err;
		}
		else
			callback(stdout.trim());
	});
}

// STARTUP RACE
/* Look up imagemagick paths */
let identifyBin, convertBin;
which('identify', bin => { identifyBin = bin; });
which('convert', bin => { convertBin = bin; });

let ffmpegBin;
if (config.VIDEO) {
	which('ffmpeg', bin => { ffmpegBin = bin; });
}

/* optional JPEG auto-rotation */
let jpegtranBin, jheadBin;
which('jpegtran', bin => { jpegtranBin = bin; }, 'graceful');
which('jhead', bin => { jheadBin = bin; }, 'graceful');

const perceptualBin = path.join(__dirname, 'perceptual');

async function identify(taggedName) {
	const args = ['-format', '%Wx%H', taggedName + '[0]'];
	let line;
	try {
		const { stdout } = await etc.execFile(identifyBin, args);
		line = stdout.trim();
	}
	catch (err) {
		const stderr = err.stderr || '';
		let msg = "Bad image.";
		if (stderr.match(/no such file/i))
			msg = "Image went missing.";
		else if (stderr.match(/improper image header/i)) {
			const m = taggedName.match(/^(\w{3,4}):/);
			let kind = m && m[1];
			kind = kind ? `a ${kind.toUpperCase()}` : 'an image';
			msg = `File is not ${kind}.`;
		}
		else if (stderr.match(/no decode delegate/i))
			msg = "Unsupported file type.";
		throw Muggle(msg, stderr);
	}

	const m = line.match(/(\d+)x(\d+)/);
	if (!m)
		throw Muggle("Couldn't read image dimensions.");
	else {
		const width = parseInt(m[1], 10);
		const height = parseInt(m[2], 10);
		return { width, height };
	}
}

class ConvertJob extends jobs.Job {
	constructor(args, src) {
		super();
		this.args = args;
		this.src = src;
	}

	async perform_job() { await etc.execFile(convertBin, this.args); }

	toString() { return `[ImageMagick conversion of ${this.src}]`; }
}

async function perceptual_hash(src, image) {
	const tmp = index.media_path('tmp', `hash${etc.random_id()}.gray`);
	const args = [src + '[0]'];
	const { width, height } = image.dims;
	if (width > 1000 || height > 1000)
		args.push('-sample', '800x800');
	// do you believe in magic?
	args.push('-background', 'white', '-mosaic', '+matte',
			'-scale', '16x16!',
			'-type', 'grayscale', '-depth', '8',
			tmp);
	try {
		await jobs.schedule(new ConvertJob(args, src));
	}
	catch (err) {
		throw Muggle('Hashing error.', err);
	}
	let hash;
	try {
		const { stdout } = await etc.execFile(perceptualBin, [tmp]);
		hash = stdout.trim();
	}
	catch (err) {
		throw Muggle('Hashing error.', err);
	}
	// delete in the bg
	fs.unlink(tmp, err => {
		if (err)
			winston.warn(`Deleting ${tmp}: ${err}`);
	});

	if (hash.length != 64)
		throw Muggle('Hashing problem.');
	return hash;
}

async function detect_APNG(fnm) {
	const bin = path.join(__dirname, 'findapng');
	try {
		const { stdout, stderr } = await etc.execFile(bin, [fnm]);
		if (stdout.match(/^APNG/))
			return true;
		if (stdout.match(/^PNG/))
			return false;
		throw Muggle('APNG detector acting up.', stderr);
	}
	catch (err) {
		throw Muggle('APNG detector problem.', err);
	}
}

function setup_image_params(o) {
	// only the first time!
	if (o.setup) return;
	o.setup = true;

	o.src += '[0]'; // just the first frame of the animation

	o.dest = `${o.format}:${o.dest}`;
	if (o.compDest)
		o.compDest = `${o.format}:${o.compDest}`;
	const [w, h] = o.dims;
	o.flatDims = `${w}x${h}`;
	if (o.compDims) {
		const [w, h] = o.compDims;
		o.compDims = `${w}x${h}`;
	}

	o.quality += ''; // coerce to string
}

function build_im_args(o) {
	// avoid OOM killer
	const args = ['-limit', 'memory', '32', '-limit', 'map', '64'];
	const [w, h] = o.dims;
	// resample from twice the thumbnail size
	// (avoid sampling from the entirety of enormous 6000x6000 images etc)
	const samp = `${w*2}x${h*2}`;
	if (o.ext == '.jpg')
		args.push('-define', 'jpeg:size=' + samp);
	setup_image_params(o);
	args.push(o.src);
	if (o.ext != '.jpg')
		args.push('-sample', samp);
	// gamma-correct yet shitty downsampling
	args.push('-gamma', '0.454545', '-filter', 'box');
	return args;
}

async function resize_image(o, comp) {
	const args = build_im_args(o);
	const dims = comp ? o.compDims : o.flatDims;
	const dest = comp ? o.compDest : o.dest;
	// in the composite case, zoom to fit. otherwise, force new size
	args.push('-resize', dims + (comp ? '^' : '!'));
	// add background
	args.push('-gamma', '2.2');
	if (o.bg)
		args.push('-background', o.bg);
	if (comp)
		args.push(o.composite, '-layers', 'flatten', '-extent', dims);
	else if (o.bg)
		args.push('-layers', 'mosaic', '+matte');
	// disregard metadata, acquire artifacts
	args.push('-strip', '-quality', o.quality);
	args.push(dest);
	try {
		await jobs.schedule(new ConvertJob(args, o.src));
	}
	catch (err) {
		winston.warn(err);
		throw Muggle("Resizing error.", err);
	}
	return dest;
}

IU.resize_and_track = async function (o, comp) {
	let fnm = await resize_image(o, comp);

	// HACK: strip IM type tag
	const m = /^\w{3,4}:(.+)$/.exec(fnm);
	if (m)
		fnm = m[1];

	await this.db.track_temporary(fnm);
};

function image_files(image) {
	const files = [];
	if (image.path)
		files.push(image.path);
	if (image.thumb_path)
		files.push(image.thumb_path);
	if (image.mid_path)
		files.push(image.mid_path);
	if (image.comp_path)
		files.push(image.comp_path);
	return files;
}

IU.failure = function (err) {
	let err_desc = 'Unknown image processing error.'
	if (err instanceof Muggle) {
		err_desc = err.most_precise_error_message();
		err = err.deepest_reason();
	}
	if (is_standalone())
		winston.error(err);

	this.respond(500, err_desc);
	if (!this.failed) {
		this.client_call('error', err_desc);
		this.failed = true;
	}
	if (this.image) {
		const files = image_files(this.image);
		for (let file of files) {
			fs.unlink(file, err => {
				if (err)
					winston.warn(`Deleting ${file}: ${err}`);
			});
		}
		this.db.lose_temporaries(files).catch(err => {
			winston.warn(`Tracking failure: ${err}`);
		});
	}
	this.db.disconnect();
};

IU.record_image = async function (tmps) {
	const { image } = this;
	const view = {};
	for (let key of index.image_attrs) {
		if (key in image)
			view[key] = image[key];
	}
	if (image.composite) {
		view.realthumb = view.thumb;
		view.thumb = image.composite;
	}
	view.pinky = image.pinky;
	const image_id = etc.random_id().toFixed();
	const alloc = {image: view, tmps};
	
	try {
		await this.db.record_image_alloc(image_id, alloc);
	}
	catch (err) {
		throw Muggle("Image storage failure.", err);
	}
	this.client_call('alloc', image_id);
	this.db.disconnect();
	this.respond(202, 'OK');

	if (is_standalone()) {
		const size = Math.ceil(view.size / 1000);
		winston.info(`upload: ${view.src} ${size}kb`);
	}
};

async function run_daemon() {
	const cd = config.DAEMON;
	const is_unix_socket = (typeof cd.LISTEN_PORT == 'string');
	if (is_unix_socket) {
		try { fs.unlinkSync(cd.LISTEN_PORT); } catch (e) {}
	}

	const server = require('http').createServer(new_upload);
	server.listen(cd.LISTEN_PORT);
	if (is_unix_socket) {
		fs.chmodSync(cd.LISTEN_PORT, '777'); // TEMP
	}

	try {
		await index._make_media_dir(null, 'tmp');
	} catch (e) {
		winston.warn(e);
	}

	winston.info('Imager daemon listening on '
			+ (cd.LISTEN_HOST || '')
			+ (is_unix_socket ? '' : ':')
			+ (cd.LISTEN_PORT + '.'));
}

if (require.main == module) (async () => {
	if (!is_standalone())
		throw new Error("Please enable DAEMON in imager/config.js");

	{
		const onegai = new imagerDb.Onegai;
		try {
			await onegai.delete_temporaries();
		}
		finally {
			onegai.disconnect();
		}
	}

	process.nextTick(() => {
		run_daemon().catch(err => { winston.error(err); process.exit(1); });
	});
})();
