const winston = require('winston');

// we only run one job at a time by default; thumbnailing is fast but can use a lot of RAM
let JOB_LIMIT = 1;
// to fix: sometimes the imager breaks down for a while and then works again
// (some job must be stalling and getting timed out)
let JOB_TIMEOUT = 30 * 1000;

const JOB_QUEUE = [];
let JOBS_RUNNING = 0;

function schedule(job) {
	if (job) {
		if (job.running)
			winston.warn(`Job ${job} already running!`);
		else if (JOB_QUEUE.includes(job))
			winston.warn(`Job ${job} already scheduled!`);
		else
			JOB_QUEUE.push(job);
	}

	while (JOB_QUEUE.length && JOBS_RUNNING < JOB_LIMIT)
		JOB_QUEUE.shift().start_job();

	if (job)
		return job.promise;
}
exports.schedule = schedule;

/// Subclasses must implement `perform_job` and should override `toString`.
class Job {
constructor() {
	this.promise = new Promise((resolve, reject) => {
		this.resolve = resolve;
		this.reject = reject;
	});
}

get running() {
	return !!this.timeout;
}

start_job() {
	if (this.running) {
		winston.warn(`${this} already started!`);
		return this.promise;
	}

	setTimeout(async () => {
		let err, result;
		try {
			result = await this.perform_job();
		}
		catch (e) {
			err = e || 'unknown job error';
		}

		clearTimeout(this.timeout);
		this.timeout = 0;
		JOBS_RUNNING--;
		if (JOBS_RUNNING < 0)
			winston.warn(`Negative job count: ${JOBS_RUNNING}`);

		setTimeout(schedule, 0);

		const { resolve, reject } = this;
		if (resolve) {
			this.reject = this.resolve = null;
			if (err)
				reject(err);
			else
				resolve(result);
		}
	}, 0);
	this.timeout = setTimeout(this.timeout_job.bind(this), JOB_TIMEOUT);
	JOBS_RUNNING++;
	return this.promise;
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

	setTimeout(schedule, 0);

	const { reject } = this;
	if (reject) {
		this.reject = this.resolve = null;
		reject(Muggle('Job timed out.'));
	}
}

toString() { return '[anonymous Job]'; }

}
exports.Job = Job;
