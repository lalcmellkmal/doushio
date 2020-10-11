const events = require('events'),
    winston = require('winston');

// we only run one job at a time by default; thumbnailing is fast but can use a lot of RAM
let JOB_LIMIT = 1;
// to fix: sometimes the imager breaks down for a while and then works again
// (some job must be stalling and getting timed out)
let JOB_TIMEOUT = 30 * 1000;

const JOB_QUEUE = [];
let JOBS_RUNNING = 0;

function schedule(job, cb) {
	if (job && job.running)
		winston.warn(`Job ${job} already running!`);
	else if (job && JOB_QUEUE.includes(job))
		winston.warn(`Job ${job} already scheduled!`);
	else if (job) {
		JOB_QUEUE.push(job);
		if (cb) {
			/* Sucks */
			job.once('finish', cb);
			job.once('timeout', () => cb("Timed out."));
		}
	}

	while (JOB_QUEUE.length && JOBS_RUNNING < JOB_LIMIT)
		JOB_QUEUE.shift().start_job();
}
exports.schedule = schedule;

/// Subclasses must implement `perform_job` and should override `toString`.
class Job extends events.EventEmitter {
get running() {
	return !!this.timeout;
}

start_job() {
	if (this.running) {
		winston.warn(`${this} already started!`);
		return;
	}
	JOBS_RUNNING++;
	this.timeout = setTimeout(this.timeout_job.bind(this), JOB_TIMEOUT);
	setTimeout(this.perform_job.bind(this), 0);
}

finish_job(p1, p2) {
	if (!this.running) {
		winston.warn(`Attempted to finish stopped job: ${this}`);
		return;
	}

	clearTimeout(this.timeout);
	this.timeout = 0;
	JOBS_RUNNING--;
	if (JOBS_RUNNING < 0)
		winston.warn(`Negative job count: ${JOBS_RUNNING}`);

	this.emit('finish', p1, p2);
	// schedule the next job if any
	schedule(null);
}

timeout_job() {
	const desc = this.toString();
	if (!this.running) {
		winston.warn(`Job ${desc} timed out though finished?!`);
		return;
	}

	winston.error(`${desc} timed out.`);

	this.timeout = 0;
	JOBS_RUNNING--;
	if (JOBS_RUNNING < 0)
		winston.warn(`Negative job count: ${JOBS_RUNNING}`);

	this.emit('timeout');
	schedule(null);
}

toString() { return '[anonymous Job]'; }

}
exports.Job = Job;
