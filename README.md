Real-time imageboard.
MIT licensed.

Setup:

* Install dependencies listed below
* Sign up for reCAPTCHA
* Create a GitHub Application (callback URL = site URL + /login)
* Copy config.js.example to config.js and configure
* Copy hot.js.example to hot.js and configure
* Copy imager/config.js.example to imager/config.js and configure
* Copy report/config.js.example to report/config.js and configure
* Clone [assets](https://github.com/lalcmellkmal/assets/) and copy the `kana` spoiler image folder as `./www/kana/` (or create your own!).
* Run `npm install` to install npm deps and compile a few helpers
* Run `node builder.js` to run an auto-reloading development server

Production:

* Have your webserver serve www/ (or wherever you've moved src, thumb, etc.)
  - Configure `imager.config.MEDIA_URL` appropriately
  - Then turn off `SERVE_STATIC_FILES` and `SERVE_IMAGES`
* If you're behind Cloudflare turn on `CLOUDFLARE`
  - Or if you're behind any reverse proxy (nginx etc) turn on `TRUST_X_FORWARDED_FOR`
* Run `node server/server.js` for just the server
* You can update client code & hot.js on-the-fly with `node server/kill.js`
* For nginx hosting/reverse proxying, refer to docs/nginx.conf.example
* For a sample init script, refer to docs/doushio.initscript.example
* config.DAEMON support is old and broken, PRs welcome

Dependencies:

* ImageMagick
* libpng
* node.js + npm
* `npm install -g node-gyp`
* redis
* ffmpeg 2.2+ if supporting WebM
* jhead and jpegtran optionally, for EXIF autorotation

Optional npm deps for various features:

* ~~daemon~~ (broken currently)
* [send](https://github.com/visionmedia/send) (if you want to serve static files directly from the node.js process; useful in debug mode also)

Standalone upkeep scripts:

* archive/daemon.js - moves old threads to the archive
* upkeep/backup.js - uploads rdb to S3
* upkeep/clean.js - deletes archived images
