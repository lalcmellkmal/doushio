{
	'targets': [{
		'target_name': 'tripcode',
		"include_dirs" : [
			"<!(node -e \"require('nan')\")"
		],
		'sources': ['tripcode.cc'],
		'link_settings': {
			'conditions': [
				['OS=="linux"', {'libraries': ['-lcrypt', '-liconv']}],
				['OS=="freebsd"', {'libraries': ['-lcrypt', '-liconv']}],
				['OS=="mac"', {'libraries': ['-lcrypto', '-liconv']}]
			]
		}
	}]
}
