
all: build

build: tripcode.node

tripcode.node: node_modules tripcode.cc
	node-gyp build
	@cp build/Release/$@ $@

node_modules: package.json binding.gyp
	npm install
	node-gyp configure

rebuild:
	node-gyp rebuild

test: build
	node test.js

.PHONY: all build clean rebuild test waf

clean:
	rm -rf -- build node_modules tripcode.node
