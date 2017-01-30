local key = KEYS[1]
local body_key = KEYS[2]
local liveposts = KEYS[3]

local body = redis.call('get', body_key)
if body then
  redis.call('hset', key, 'body', body)
  redis.call('del', body_key)
end
redis.call('hdel', key, 'state')
redis.call('srem', liveposts, key)
