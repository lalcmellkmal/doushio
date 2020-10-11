const async = require('async'),
    config = require('./config'),
    child_process = require('child_process'),
    etc = require('../etc'),
    { Muggle } = etc,
    imagerDb = require('./db'),
    index = require('./'),
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

function get_thumb_specs(image, pinky, scale) {
	const w = image.dims[0], h = image.dims[1];
	const bound = config[pinky ? 'PINKY_DIMENSIONS' : 'THUMB_DIMENSIONS'];
	const r = Math.max(w / bound[0], h / bound[1], 1);
	const dims = [Math.round(w/r) * scale, Math.round(h/r) * scale];
	const specs = {bound, dims, format: 'jpg'};
	// Note: WebMs pretend to be PNGs at this step,
	//       but those don't need transparent backgrounds.
	//       (well... WebMs *can* have alpha channels...)
	if (config.PNG_THUMBS && image.ext == '.png' && !image.video) {
		specs.format = 'png';
		specs.quality = config.PNG_THUMB_QUALITY;
	}
	else if (pinky) {
		specs.bg = '#ffffff';
		specs.quality = config.PINKY_QUALITY;
	}
	else {
		specs.bg = '#ffffff';
		specs.quality = config.THUMB_QUALITY;
	}
	return specs;
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
	this.resp.end('<!doctype html><title>Upload result</title>\n'
		+ 'This is a legitimate imager response.\n'
		+ '<script>\nparent.postMessage(' + etc.json_paranoid(msg)
		+ ', ' + etc.json_paranoid(origin) + ');\n'
		+ '</script>\n');
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
	form.once('error', (err) => {
		this.failure(Muggle('Upload request problem.', err));
	});
	form.once('aborted', (err) => {
		this.failure(Muggle('Upload was aborted.', err));
	});
	this.lastProgress = 0;
	form.on('progress', this.upload_progress_status.bind(this));

	try {
		form.parse(req, (err, fields, files) => {
			if (err)
				return this.failure(Muggle('Invalid upload.', err));
			const { image } = files;
			if (!image)
				return this.failure(Muggle('No image.'));
			this.image = image;
			this.parse_form(fields);
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

IU.parse_form = function (fields) {
	this.pinky = !!parseInt(fields.op, 10);

	const spoiler = parseInt(fields.spoiler, 10);
	if (spoiler) {
		const sps = config.SPOILER_IMAGES;
		if (sps.normal.indexOf(spoiler) < 0 && sps.trans.indexOf(spoiler) < 0)
			return this.failure(Muggle('Bad spoiler.'));
		this.image.spoiler = spoiler;
	}

	this.image.MD5 = index.squish_MD5(this.image.hash);
	this.image.hash = null;

	this.db.track_temporary(this.image.path, (err) => {
		if (err)
			winston.warn("Temp tracking error: " + err);
		this.process();
	});
};

IU.process = function () {
	if (this.failed)
		return;
	const { image } = this;
	const filename = image.filename || image.name;
	image.ext = path.extname(filename).toLowerCase();
	if (image.ext == '.jpeg')
		image.ext = '.jpg';
	if (image.ext == '.mov')
		image.ext = '.mp4';
	const { ext } = image;

	const isVideoExt = config.VIDEO_EXTS.includes(ext);
	if (!IMAGE_EXTS.includes(ext) && (!config.VIDEO || !isVideoExt))
		return this.failure(Muggle('Invalid image format.'));
	image.imgnm = filename.substr(0, 256);

	this.status('Verifying...');
	if (isVideoExt)
		jobs.schedule(new StillJob(image.path, ext), this.verify_video.bind(this));
	else if (ext == '.jpg' && jpegtranBin && jheadBin)
		jobs.schedule(new AutoRotateJob(image.path), this.verify_image.bind(this));
	else
		this.verify_image();
};

class AutoRotateJob extends jobs.Job {
constructor(src) {
	super();
	this.src = src;
}
toString() { return `[jhead+jpegtran auto rotation of ${this.src}`; }

async perform_job() {
	try {
		await etc.execFile(jheadBin, ['-autorot', this.src]);
	}
	catch (err) {
		// if it failed, keep calm and thumbnail on
		winston.warn('jhead: ' + (stderr || err));
	}
}
} // AutoRotateJob end

class StillJob extends jobs.Job {
constructor(src, ext) {
	super();
	this.src = src;
	this.ext = ext;
}
toString() { return `[FFmpeg video still of ${this.src}]`; }

async perform_job() {
	const dest = index.media_path('tmp', 'still_'+etc.random_id());
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
		dur = (m ? m + 'm' : '') + s + 's';
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

IU.verify_video = function (err, info) {
	if (err)
		return this.failure(err);

	this.db.track_temporary(info.still_path, (err) => {
		if (err)
			winston.warn("Tracking error: " + err);

		if (info.has_audio && !config.AUDIO)
			return this.failure(Muggle('Audio is not allowed.'));

		// pretend it's a PNG for the next steps
		const { image } = this;
		image.video = image.ext.replace('.', '');
		image.video_path = image.path;
		image.path = info.still_path;
		image.ext = '.png';
		if (info.has_audio) {
			image.audio = true;
			if (config.AUDIO_SPOILER)
				image.spoiler = config.AUDIO_SPOILER;
		}
		if (info.duration)
			image.duration = info.duration;

		this.verify_image();
	});
};

IU.verify_image = function (err) {
	if (err)
		winston.error(err);
	const { image } = this;
	this.tagged_path = image.ext.replace('.', '') + ':' + image.path;
	const checks = {
		stat: fs.stat.bind(fs, image.video_path || image.path),
		dims: identify.bind(null, this.tagged_path),
	};
	if (image.ext == '.png')
		checks.apng = detect_APNG.bind(null, image.path);

	async.parallel(checks, (err, rs) => {
		if (err)
			return this.failure(Muggle('Wrong image type.', err));
		image.size = rs.stat.size;
		image.dims = [rs.dims.width, rs.dims.height];
		if (rs.apng)
			image.apng = 1;
		this.verified();
	});
};

IU.verified = function () {
	if (this.failed)
		return;
	const desc = this.image.video ? 'Video' : 'Image';
	const w = this.image.dims[0], h = this.image.dims[1];
	if (!w || !h)
		return this.failure(Muggle('Bad image dimensions.'));
	if (config.IMAGE_PIXELS_MAX && w * h > config.IMAGE_PIXELS_MAX)
		return this.failure(Muggle('Way too many pixels.'));
	if (w > config.IMAGE_WIDTH_MAX && h > config.IMAGE_HEIGHT_MAX)
		return this.failure(Muggle(desc+' is too wide and too tall.'));
	if (w > config.IMAGE_WIDTH_MAX)
		return this.failure(Muggle(desc+' is too wide.'));
	if (h > config.IMAGE_HEIGHT_MAX)
		return this.failure(Muggle(desc+' is too tall.'));

	perceptual_hash(this.tagged_path, this.image, (err, hash) => {
		if (err)
			return this.failure(err);
		this.image.hash = hash;
		this.db.check_duplicate(hash, (err) => {
			if (err)
				return this.failure(err);
			this.deduped();
		});
	});
};

IU.fill_in_specs = function (specs, kind) {
	specs.src = this.tagged_path;
	specs.ext = this.image.ext;
	specs.dest = this.image.path + '_' + kind;
	this.image[kind + '_path'] = specs.dest;
};

IU.deduped = function () {
	if (this.failed)
		return;
	const { image } = this;
	const specs = get_thumb_specs(image, this.pinky, 1);
	const w = image.dims[0], h = image.dims[1];

	/* Determine whether we really need a thumbnail */
	let sp = image.spoiler;
	if (!sp && image.size < 30*1024
			&& ['.jpg', '.png'].indexOf(image.ext) >= 0
			&& !image.apng && !image.video
			&& w <= specs.dims[0] && h <= specs.dims[1]) {
		return this.got_nails();
	}
	this.fill_in_specs(specs, 'thumb');

	// was a composited spoiler selected or forced?
	if (image.audio && config.AUDIO_SPOILER)
		specs.comp = specs.overlay = true;
	if (sp && config.SPOILER_IMAGES.trans.indexOf(sp) >= 0)
		specs.comp = true;

	if (specs.comp) {
		this.status(specs.overlay ? 'Overlaying...' : 'Spoilering...');
		const comp = composite_src(sp, this.pinky);
		image.comp_path = image.path + '_comp';
		specs.compDims = specs.overlay ? specs.dims : specs.bound;
		image.dims = [w, h].concat(specs.compDims);
		specs.composite = comp;
		specs.compDest = image.comp_path;
		async.parallel([
			this.resize_and_track.bind(this, specs, false),
			this.resize_and_track.bind(this, specs, true),
		], (err) => {
			if (err)
				return this.failure(err);
			this.got_nails();
		});
	}
	else {
		image.dims = [w, h].concat(specs.dims);
		if (!sp)
			this.status('Thumbnailing...');

		this.resize_and_track(specs, false, (err) => {
			if (err)
				return this.failure(err);

			if (config.EXTRA_MID_THUMBNAILS)
				this.middle_nail();
			else
				this.got_nails();
		});
	}
};

IU.middle_nail = function () {
	if (this.failed)
		return;

	const specs = get_thumb_specs(this.image, this.pinky, 2);
	this.fill_in_specs(specs, 'mid');

	this.resize_and_track(specs, false, (err) => {
		if (err)
			return this.failure(err);
		this.got_nails();
	});
};

IU.got_nails = function () {
	if (this.failed)
		return;

	const { image } = this;
	if (image.video_path) {
		// stop pretending this is just a still image
		image.path = image.video_path;
		image.ext = '.' + image.video;
		delete image.video_path;
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
		image.composite = time + 's' + image.spoiler + '.jpg';
		tmps.comp = base(image.comp_path);
		delete image.spoiler;
	}

	this.record_image(tmps);
};

function composite_src(spoiler, pinky) {
	const file = `spoiler${pinky ? 's' : ''}${spoiler}.png`;
	return path.join(config.SPOILER_DIR, file);
}

IU.read_image_filesize = function (callback) {
	fs.stat(this.image.path, (err, stat) => {
		if (err)
			callback(Muggle('Internal filesize error.', err));
		else if (stat.size > config.IMAGE_FILESIZE_MAX)
			callback(Muggle('File is too large.'));
		else
			callback(null, stat.size);
	});
};

function which(name, callback) {
	child_process.exec('which ' + name, (err, stdout, stderr) => {
		if (err)
			callback(err);
		else
			callback(null, stdout.trim());
	});
}

// STARTUP RACE
/* Look up imagemagick paths */
let identifyBin, convertBin;
which('identify', function (err, bin) { if (err) throw err; identifyBin = bin; });
which('convert', function (err, bin) { if (err) throw err; convertBin = bin; });

let ffmpegBin;
if (config.VIDEO) {
	which('ffmpeg', function (err, bin) { if (err) throw err; ffmpegBin = bin; });
}

/* optional JPEG auto-rotation */
let jpegtranBin, jheadBin;
which('jpegtran', function (err, bin) { if (!err && bin) jpegtranBin = bin; });
which('jhead', function (err, bin) { if (!err && bin) jheadBin = bin; });

function identify(taggedName, callback) {
	const args = ['-format', '%Wx%H', taggedName + '[0]'];
	child_process.execFile(identifyBin, args, (err, stdout, stderr) => {
		if (err) {
			let msg = "Bad image.";
			if (stderr.match(/no such file/i))
				msg = "Image went missing.";
			else if (stderr.match(/improper image header/i)) {
				const m = taggedName.match(/^(\w{3,4}):/);
				let kind = m && m[1];
				kind = kind ? 'a ' + kind.toUpperCase() : 'an image';
				msg = `File is not ${kind}.`;
			}
			else if (stderr.match(/no decode delegate/i))
				msg = "Unsupported file type.";
			return callback(Muggle(msg, stderr));
		}

		const line = stdout.trim();
		const m = line.match(/(\d+)x(\d+)/);
		if (!m)
			callback(Muggle("Couldn't read image dimensions."));
		else {
			const width = parseInt(m[1], 10);
			const height = parseInt(m[2], 10);
			callback(null, {width, height});
		}
	});
}

class ConvertJob extends jobs.Job {
constructor(args, src) {
	super();
	this.args = args;
	this.src = src;
}

async perform_job() {
	await etc.execFile(convertBin, this.args);
};

toString() { return `[ImageMagick conversion of ${this.src}]`; }
} // ConvertJob end

function convert(args, src, callback) {
	jobs.schedule(new ConvertJob(args, src), callback);
}

function perceptual_hash(src, image, callback) {
	const tmp = index.media_path('tmp', 'hash' + etc.random_id() + '.gray');
	const args = [src + '[0]'];
	if (image.dims.width > 1000 || image.dims.height > 1000)
		args.push('-sample', '800x800');
	// do you believe in magic?
	args.push('-background', 'white', '-mosaic', '+matte',
			'-scale', '16x16!',
			'-type', 'grayscale', '-depth', '8',
			tmp);
	convert(args, src, (err) => {
		if (err)
			return callback(Muggle('Hashing error.', err));
		const bin = path.join(__dirname, 'perceptual');
		child_process.execFile(bin, [tmp], (err, stdout, stderr) => {
			fs.unlink(tmp, err => {
				if (err)
					winston.warn(`Deleting ${tmp}: ${err}`);
			});
			if (err)
				return callback(Muggle('Hashing error.', stderr || err));
			const hash = stdout.trim();
			if (hash.length != 64)
				return callback(Muggle('Hashing problem.'));
			callback(null, hash);
		});
	});
}

function detect_APNG(fnm, callback) {
	const bin = path.join(__dirname, 'findapng');
	child_process.execFile(bin, [fnm], (err, stdout, stderr) => {
		if (err)
			return callback(Muggle('APNG detector problem.', stderr || err));
		else if (stdout.match(/^APNG/))
			return callback(null, true);
		else if (stdout.match(/^PNG/))
			return callback(null, false);
		else
			return callback(Muggle('APNG detector acting up.', stderr || err));
	});
}

function setup_image_params(o) {
	// only the first time!
	if (o.setup) return;
	o.setup = true;

	o.src += '[0]'; // just the first frame of the animation

	o.dest = o.format + ':' + o.dest;
	if (o.compDest)
		o.compDest = o.format + ':' + o.compDest;
	o.flatDims = o.dims[0] + 'x' + o.dims[1];
	if (o.compDims)
		o.compDims = o.compDims[0] + 'x' + o.compDims[1];

	o.quality += ''; // coerce to string
}

function build_im_args(o) {
	// avoid OOM killer
	const args = ['-limit', 'memory', '32', '-limit', 'map', '64'];
	const dims = o.dims;
	// resample from twice the thumbnail size
	// (avoid sampling from the entirety of enormous 6000x6000 images etc)
	const samp = dims[0]*2 + 'x' + dims[1]*2;
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

function resize_image(o, comp, callback) {
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
	convert(args, o.src, (err) => {
		if (err) {
			winston.warn(err);
			callback(Muggle("Resizing error.", err));
		}
		else
			callback(null, dest);
	});
}

IU.resize_and_track = function (o, comp, cb) {
	resize_image(o, comp, (err, fnm) => {
		if (err)
			return cb(err);

		// HACK: strip IM type tag
		const m = /^\w{3,4}:(.+)$/.exec(fnm);
		if (m)
			fnm = m[1];

		this.db.track_temporary(fnm, cb);
	});
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
	/* Don't bother logging PEBKAC errors */
	if (!(err instanceof Muggle))
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
		this.db.lose_temporaries(files, err => {
			if (err)
				winston.warn("Tracking failure: " + err);
		});
	}
	this.db.disconnect();
};

IU.record_image = function (tmps) {
	if (this.failed)
		return;
	const view = {};
	for (let key of index.image_attrs) {
		if (key in this.image)
			view[key] = this.image[key];
	}
	if (this.image.composite) {
		view.realthumb = view.thumb;
		view.thumb = this.image.composite;
	}
	view.pinky = this.pinky;
	const image_id = etc.random_id().toFixed();
	const alloc = {image: view, tmps};
	this.db.record_image_alloc(image_id, alloc, err => {
		if (err)
			return this.failure("Image storage failure.");
		this.client_call('alloc', image_id);
		this.db.disconnect();
		this.respond(202, 'OK');

		if (index.is_standalone()) {
			const size = Math.ceil(view.size / 1000);
			winston.info(`upload: ${view.src} ${size}kb`);
		}
	});
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
	if (!index.is_standalone())
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
