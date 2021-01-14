(function () {

function drop_shita(e) {
	e.stopPropagation();
	e.preventDefault();
	const { files } = e.dataTransfer;
	if (!files.length)
		return;
	if (!postForm) {
		with_dom(() => {
			if (THREAD)
				open_post_box(THREAD);
			else {
				const $s = $(e.target).closest('section');
				if (!$s.length)
					return;
				open_post_box($s.attr('id'));
			}
		});
	}
	else {
		const { uploading, uploaded } = postForm.model.attributes;
		if (uploading || uploaded)
			return;
	}

	if (files.length > 1) {
		postForm.upload_error('Too many files.');
		return;
	}

	const extra = postForm.prep_upload();
	const fd = new FormData();
	fd.append('image', files[0]);
	for (let k in extra)
		fd.append(k, extra[k]);
	/* Can't seem to jQuery this shit */
	const xhr = new XMLHttpRequest();
	xhr.open('POST', image_upload_url());
	xhr.setRequestHeader('Accept', 'application/json');
	xhr.onreadystatechange = upload_shita;
	xhr.send(fd);

	postForm.notify_uploading();
}

function upload_shita() {
	if (this.readyState != 4 || this.status == 202)
		return;
	let err = this.responseText;
	if (this.status != 500 || !err || err.length > 100)
		err = "Couldn't get response.";
	postForm.upload_error(err)
}

function stop_drag(e) {
	e.stopPropagation();
	e.preventDefault();
}

function setup_upload_drop(e) {
	function go(nm, f) { e.addEventListener(nm, f, false); }
	go('dragenter', stop_drag);
	go('dragexit', stop_drag);
	go('dragover', stop_drag);
	go('drop', drop_shita);
}

setup_upload_drop(document.body);

})();
