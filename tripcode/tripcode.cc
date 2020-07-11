#define _XOPEN_SOURCE
#include <errno.h>
#include <iconv.h>
#include <unistd.h>
#include <string.h>
#include "napi.h"

using namespace Napi;

static char SECURE_SALT[21] = "$5$";
#define TRIP_MAX 128

/// Call this once at startup to set the salt for secure (!!) tripcodes.
Value set_salt(const CallbackInfo& info) {
	Env env = info.Env();

	if (info.Length() != 1) {
		TypeError::New(env, "setSalt takes one argument")
			.ThrowAsJavaScriptException();
		return env.Null();
	}
	String saltVal = info[0].As<String>();
	std::string salt = saltVal.Utf8Value();
	if (salt.length() != 16) {
		TypeError::New(env, "setSalt takes a string of length 16")
			.ThrowAsJavaScriptException();
		return env.Null();
	}
	memcpy(SECURE_SALT + 3, salt.c_str(), 16);
	SECURE_SALT[19] = '$';
	SECURE_SALT[20] = 0;
	return env.Null();
}

static void fix_char(char &c) {
	static const char *from = ":;<=>?@[\\]^_`", *to = "ABCDEFGabcdef";
	const char *p;
	if (c < '.' || c > 'z')
		c = '.';
	else if ((p = strchr(from, c)))
		c = to[p - from];
}

static void hash_trip(char *key, size_t len, char *dest) {
	char *digest, salt[3] = "..";
	if (len == 1)
		salt[0] = 'H';
	else if (len == 2) {
		salt[0] = key[1];
		salt[1] = 'H';
	}
	else if (len)
		strncpy(salt, key + 1, 2);
	fix_char(salt[0]);
	fix_char(salt[1]);
	digest = crypt(key, salt);
	if (!digest)
		return;
	len = strlen(digest);
	if (len < 11)
		return;
	digest += len - 11;
	digest[0] = '!';
	strncpy(dest, digest, 12);
}

static void hash_secure(char *key, size_t len, char *dest) {
	size_t i;
	char *digest;
	if (len > TRIP_MAX) {
		len = TRIP_MAX;
		key[TRIP_MAX] = 0;
	}
	for (i = 0; i < len; i++)
		fix_char(key[i]);
	digest = crypt(key, SECURE_SALT);
	if (!digest)
		return;
	len = strlen(digest);
	if (len < 12)
		return;
	digest += len - 12;
	digest[0] = digest[1] = '!';
	strncpy(dest, digest, 13);
}

static iconv_t conv_desc;

static int setup_conv() {
	conv_desc = iconv_open("SHIFT_JIS", "UTF-8");
	if (conv_desc == (iconv_t) -1) {
		fprintf(stderr, "Can't convert to SHIFT_JIS.\n");
		return 0;
	}
	return 1;
}

typedef void (*trip_f)(char *, size_t, char *);

static bool with_SJIS(std::string trip, trip_f func, char *ret) {
	// cast for iconv's non-const interface
	char *src = const_cast<char *>(trip.c_str());
	if (!src)
		return true;
	size_t src_left = trip.length(), dest_left = TRIP_MAX;
	if (!src_left)
		return true;
	if (src_left > TRIP_MAX / 2)
		src_left = TRIP_MAX / 2;
	char sjis[TRIP_MAX+1];
	char *dest = sjis;
	size_t result = iconv(conv_desc, &src, &src_left, &dest, &dest_left);
	if (result == (size_t) -1 && errno != EILSEQ && errno != EINVAL) {
		perror("iconv");
		return false;
	}
	ssize_t len = TRIP_MAX - dest_left;
	if (len > 0) {
		sjis[len] = 0;
		func(sjis, len, ret);
	}
	return true;
}

/// Takes two strings (trip, secure_trip) and returns the hashed tripcode result.
Value hash(const CallbackInfo& info) {
	Env env = info.Env();

	if (info.Length() != 2) {
		TypeError::New(env, "hash takes 2 arguments")
			.ThrowAsJavaScriptException();
		return Value::From(env, env.Null());
	}

	String trip = info[0].As<String>();
	String secure = info[1].As<String>();
	char digest[24];
	digest[0] = 0;
	if (!with_SJIS(trip.Utf8Value(), &hash_trip, digest)) {
		TypeError::New(env, "trip encoding error")
			.ThrowAsJavaScriptException();
		return Value::From(env, env.Null());
	}
	if (!with_SJIS(secure.Utf8Value(), &hash_secure, digest + strlen(digest))) {
		TypeError::New(env, "secure trip encoding error")
			.ThrowAsJavaScriptException();
		return Value::From(env, env.Null());
	}

	return Value::From(env, digest);
}

Object init(Env env, Object exports) {
	if (!setup_conv()) {
		TypeError::New(env, "Could not set up iconv with SHIFT_JIS")
			.ThrowAsJavaScriptException();
		return exports;
	}
	exports.Set(String::New(env, "setSalt"), Function::New(env, set_salt));
	exports.Set(String::New(env, "hash"), Function::New(env, hash));
	return exports;
}

NODE_API_MODULE(tripcode, init)
