module.exports={apps:[
 {name:'kce-api',script:'src/server.mjs',node_args:'--env-file=.env',cwd:__dirname,instances:1,exec_mode:'fork',autorestart:true,kill_timeout:10000,time:true,env:{NODE_ENV:'production',TZ:'UTC'}},
 {name:'kce-daily',script:'src/cli.mjs',args:'scheduler',node_args:'--env-file=.env',cwd:__dirname,instances:1,exec_mode:'fork',autorestart:true,kill_timeout:45000,time:true,env:{NODE_ENV:'production',TZ:'UTC'}}
]};
