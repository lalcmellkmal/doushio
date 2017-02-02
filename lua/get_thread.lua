local function read_post(key, body_key)
  local post = redis.call('hgetall', key) -- flat bulk reply, not hash
  if post and redis.call('hexists', key, 'body') == 0 then
    local body = redis.call('get', body_key)
    if body then
      post[#post+1] = 'body'
      post[#post+1] = body
    end
  end
  return post
end

local abbrev = tonumber(ARGV[1])

local thread_key = KEYS[1]
local thread_body_key = KEYS[2]
local thread_posts_key = KEYS[3]
local liveposts_key = KEYS[4]

-- first, read the 'pre'liminary-thread, raw and without replies
local pre = read_post(thread_key, thread_body_key)
if not pre then
  return false
end

-- build the global set of live posts
-- okay if I make thread:#:posts a set, could skip this step and use `sinter`
-- except that liveposts contains keys, not numbers, argh!
local liveposts = {}
for _, key in ipairs(redis.call('smembers', liveposts_key)) do
  local num = key:match('^post:(%d+)$') -- do not convert to integer!
  if num then
    liveposts[num] = true
  end
end

local start = 0
local total = 0
if abbrev > 0 then
  start = -abbrev
  total = total + redis.call('llen', thread_posts_key)
end
-- request the list of replies
local replies = redis.call('lrange', thread_posts_key, start, -1) or {}

-- fully fetch all currently-editing replies
-- (we will fetch finished replies later since they aren't time-critical)
--
-- pretty sure this breaks EVAL rules (we use keys not passed in KEYS[])
-- but hey, if we ever use redis cluster, we could use `post:n{op}` keys
local active = {}
for _, id in ipairs(replies) do
  if liveposts[id] then
    local key = 'post:' .. id
    local post = read_post(key, key..':body')
    active[#active+1] = id
    active[#active+1] = post
  end
end

return {pre, replies, active, total}
