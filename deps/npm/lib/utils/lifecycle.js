exports = module.exports = lifecycle
exports.cmd = cmd
exports.makeEnv = makeEnv
exports._incorrectWorkingDirectory = _incorrectWorkingDirectory

var log = require('npmlog')
var spawn = require('./spawn')
var npm = require('../npm.js')
var path = require('path')
var fs = require('graceful-fs')
var chain = require('slide').chain
var Stream = require('stream').Stream
var PATH = 'PATH'
var uidNumber = require('uid-number')
var umask = require('./umask')
var usage = require('./usage')
var output = require('./output.js')
var which = require('which')

// windows calls it's path 'Path' usually, but this is not guaranteed.
if (process.platform === 'win32') {
  PATH = 'Path'
  Object.keys(process.env).forEach(function (e) {
    if (e.match(/^PATH$/i)) {
      PATH = e
    }
  })
}

function logid (pkg, stage) {
  return pkg._id + '~' + stage + ':'
}

function lifecycle (pkg, stage, wd, unsafe, failOk, cb) {
  if (typeof cb !== 'function') {
    cb = failOk
    failOk = false
  }
  if (typeof cb !== 'function') {
    cb = unsafe
    unsafe = false
  }
  if (typeof cb !== 'function') {
    cb = wd
    wd = null
  }

  while (pkg && pkg._data) pkg = pkg._data
  if (!pkg) return cb(new Error('Invalid package data'))

  log.info('lifecycle', logid(pkg, stage), pkg._id)
  if (!pkg.scripts) pkg.scripts = {}

  if (npm.config.get('ignore-scripts')) {
    log.info('lifecycle', logid(pkg, stage), 'ignored because ignore-scripts is set to true', pkg._id)
    pkg.scripts = {}
  }
  if (stage === 'prepublish' && npm.config.get('ignore-prepublish')) {
    log.info('lifecycle', logid(pkg, stage), 'ignored because ignore-prepublish is set to true', pkg._id)
    delete pkg.scripts.prepublish
  }

  if (!pkg.scripts[stage]) return cb()

  validWd(wd || path.resolve(npm.dir, pkg.name), function (er, wd) {
    if (er) return cb(er)

    unsafe = unsafe || npm.config.get('unsafe-perm')

    if ((wd.indexOf(npm.dir) !== 0 || _incorrectWorkingDirectory(wd, pkg)) &&
        !unsafe && pkg.scripts[stage]) {
      log.warn('lifecycle', logid(pkg, stage), 'cannot run in wd',
        '%s %s (wd=%s)', pkg._id, pkg.scripts[stage], wd
      )
      return cb()
    }

    // set the env variables, then run scripts as a child process.
    var env = makeEnv(pkg)
    env.npm_lifecycle_event = stage
    env.npm_node_execpath = env.NODE = env.NODE || process.execPath
    env.npm_execpath = require.main.filename

    // 'nobody' typically doesn't have permission to write to /tmp
    // even if it's never used, sh freaks out.
    if (!npm.config.get('unsafe-perm')) env.TMPDIR = wd

    lifecycle_(pkg, stage, wd, env, unsafe, failOk, cb)
  })
}

function _incorrectWorkingDirectory (wd, pkg) {
  return wd.lastIndexOf(pkg.name) !== wd.length - pkg.name.length
}

function lifecycle_ (pkg, stage, wd, env, unsafe, failOk, cb) {
  var pathArr = []
  var p = wd.split(/[\\\/]node_modules[\\\/]/)
  var acc = path.resolve(p.shift())

  p.forEach(function (pp) {
    pathArr.unshift(path.join(acc, 'node_modules', '.bin'))
    acc = path.join(acc, 'node_modules', pp)
  })
  pathArr.unshift(path.join(acc, 'node_modules', '.bin'))

  // we also unshift the bundled node-gyp-bin folder so that
  // the bundled one will be used for installing things.
  pathArr.unshift(path.join(__dirname, '..', '..', 'bin', 'node-gyp-bin'))

  if (shouldPrependCurrentNodeDirToPATH()) {
    // prefer current node interpreter in child scripts
    pathArr.push(path.dirname(process.execPath))
  }

  if (env[PATH]) pathArr.push(env[PATH])
  env[PATH] = pathArr.join(process.platform === 'win32' ? ';' : ':')

  var packageLifecycle = pkg.scripts && pkg.scripts.hasOwnProperty(stage)

  if (packageLifecycle) {
    // define this here so it's available to all scripts.
    env.npm_lifecycle_script = pkg.scripts[stage]
  } else {
    log.silly('lifecycle', logid(pkg, stage), 'no script for ' + stage + ', continuing')
  }

  function done (er) {
    if (er) {
      if (npm.config.get('force')) {
        log.info('lifecycle', logid(pkg, stage), 'forced, continuing', er)
        er = null
      } else if (failOk) {
        log.warn('lifecycle', logid(pkg, stage), 'continuing anyway', er.message)
        er = null
      }
    }
    cb(er)
  }

  chain(
    [
      packageLifecycle && [runPackageLifecycle, pkg, env, wd, unsafe],
      [runHookLifecycle, pkg, env, wd, unsafe]
    ],
    done
  )
}

function shouldPrependCurrentNodeDirToPATH () {
  var cfgsetting = npm.config.get('scripts-prepend-node-path')
  if (cfgsetting === false) return false
  if (cfgsetting === true) return true

  var isDifferentNodeInPath

  var isWindows = process.platform === 'win32'
  var foundExecPath
  try {
    foundExecPath = which.sync(path.basename(process.execPath), {pathExt: isWindows ? ';' : ':'})
    // Apply `fs.realpath()` here to avoid false positives when `node` is a symlinked executable.
    isDifferentNodeInPath = fs.realpathSync(process.execPath).toUpperCase() !==
        fs.realpathSync(foundExecPath).toUpperCase()
  } catch (e) {
    isDifferentNodeInPath = true
  }

  if (cfgsetting === 'warn-only') {
    if (isDifferentNodeInPath && !shouldPrependCurrentNodeDirToPATH.hasWarned) {
      if (foundExecPath) {
        log.warn('lifecycle', 'The node binary used for scripts is', foundExecPath, 'but npm is using', process.execPath, 'itself. Use the `--scripts-prepend-node-path` option to include the path for the node binary npm was executed with.')
      } else {
        log.warn('lifecycle', 'npm is using', process.execPath, 'but there is no node binary in the current PATH. Use the `--scripts-prepend-node-path` option to include the path for the node binary npm was executed with.')
      }
      shouldPrependCurrentNodeDirToPATH.hasWarned = true
    }

    return false
  }

  return isDifferentNodeInPath
}

function validWd (d, cb) {
  fs.stat(d, function (er, st) {
    if (er || !st.isDirectory()) {
      var p = path.dirname(d)
      if (p === d) {
        return cb(new Error('Could not find suitable wd'))
      }
      return validWd(p, cb)
    }
    return cb(null, d)
  })
}

function runPackageLifecycle (pkg, env, wd, unsafe, cb) {
  // run package lifecycle scripts in the package root, or the nearest parent.
  var stage = env.npm_lifecycle_event
  var cmd = env.npm_lifecycle_script

  var note = '\n> ' + pkg._id + ' ' + stage + ' ' + wd +
             '\n> ' + cmd + '\n'
  runCmd(note, cmd, pkg, env, stage, wd, unsafe, cb)
}

var running = false
var queue = []
function dequeue () {
  running = false
  if (queue.length) {
    var r = queue.shift()
    runCmd.apply(null, r)
  }
}

function runCmd (note, cmd, pkg, env, stage, wd, unsafe, cb) {
  if (running) {
    queue.push([note, cmd, pkg, env, stage, wd, unsafe, cb])
    return
  }

  running = true
  log.pause()
  var user = unsafe ? null : npm.config.get('user')
  var group = unsafe ? null : npm.config.get('group')

  if (log.level !== 'silent') {
    output(note)
  }
  log.verbose('lifecycle', logid(pkg, stage), 'unsafe-perm in lifecycle', unsafe)

  if (process.platform === 'win32') {
    unsafe = true
  }

  if (unsafe) {
    runCmd_(cmd, pkg, env, wd, stage, unsafe, 0, 0, cb)
  } else {
    uidNumber(user, group, function (er, uid, gid) {
      runCmd_(cmd, pkg, env, wd, stage, unsafe, uid, gid, cb)
    })
  }
}

function runCmd_ (cmd, pkg, env, wd, stage, unsafe, uid, gid, cb_) {
  function cb (er) {
    cb_.apply(null, arguments)
    log.resume()
    process.nextTick(dequeue)
  }

  var conf = {
    cwd: wd,
    env: env,
    stdio: [ 0, 1, 2 ]
  }

  if (!unsafe) {
    conf.uid = uid ^ 0
    conf.gid = gid ^ 0
  }

  var sh = 'sh'
  var shFlag = '-c'

  var customShell = npm.config.get('script-shell')

  if (customShell) {
    sh = customShell
  } else if (process.platform === 'win32') {
    sh = process.env.comspec || 'cmd'
    shFlag = '/d /s /c'
    conf.windowsVerbatimArguments = true
  }

  log.verbose('lifecycle', logid(pkg, stage), 'PATH:', env[PATH])
  log.verbose('lifecycle', logid(pkg, stage), 'CWD:', wd)
  log.silly('lifecycle', logid(pkg, stage), 'Args:', [shFlag, cmd])

  var proc = spawn(sh, [shFlag, cmd], conf)

  proc.on('error', procError)
  proc.on('close', function (code, signal) {
    log.silly('lifecycle', logid(pkg, stage), 'Returned: code:', code, ' signal:', signal)
    if (signal) {
      process.kill(process.pid, signal)
    } else if (code) {
      var er = new Error('Exit status ' + code)
      er.errno = code
    }
    procError(er)
  })
  process.once('SIGTERM', procKill)
  process.once('SIGINT', procInterupt)

  function procError (er) {
    if (er) {
      log.info('lifecycle', logid(pkg, stage), 'Failed to exec ' + stage + ' script')
      er.message = pkg._id + ' ' + stage + ': `' + cmd + '`\n' +
                   er.message
      if (er.code !== 'EPERM') {
        er.code = 'ELIFECYCLE'
      }
      fs.stat(npm.dir, function (statError, d) {
        if (statError && statError.code === 'ENOENT' && npm.dir.split(path.sep).slice(-1)[0] === 'node_modules') {
          log.warn('', 'Local package.json exists, but node_modules missing, did you mean to install?')
        }
      })
      er.pkgid = pkg._id
      er.stage = stage
      er.script = cmd
      er.pkgname = pkg.name
    }
    process.removeListener('SIGTERM', procKill)
    process.removeListener('SIGTERM', procInterupt)
    process.removeListener('SIGINT', procKill)
    return cb(er)
  }
  function procKill () {
    proc.kill()
  }
  function procInterupt () {
    proc.kill('SIGINT')
    proc.on('exit', function () {
      process.exit()
    })
    process.once('SIGINT', procKill)
  }
}

function runHookLifecycle (pkg, env, wd, unsafe, cb) {
  // check for a hook script, run if present.
  var stage = env.npm_lifecycle_event
  var hook = path.join(npm.dir, '.hooks', stage)
  var cmd = hook

  fs.stat(hook, function (er) {
    if (er) return cb()
    var note = '\n> ' + pkg._id + ' ' + stage + ' ' + wd +
               '\n> ' + cmd
    runCmd(note, hook, pkg, env, stage, wd, unsafe, cb)
  })
}

function makeEnv (data, prefix, env) {
  prefix = prefix || 'npm_package_'
  if (!env) {
    env = {}
    for (var i in process.env) {
      if (!i.match(/^npm_/)) {
        env[i] = process.env[i]
      }
    }

    // express and others respect the NODE_ENV value.
    if (npm.config.get('production')) env.NODE_ENV = 'production'
  } else if (!data.hasOwnProperty('_lifecycleEnv')) {
    Object.defineProperty(data, '_lifecycleEnv',
      {
        value: env,
        enumerable: false
      }
    )
  }

  for (i in data) {
    if (i.charAt(0) !== '_') {
      var envKey = (prefix + i).replace(/[^a-zA-Z0-9_]/g, '_')
      if (i === 'readme') {
        continue
      }
      if (data[i] && typeof data[i] === 'object') {
        try {
          // quick and dirty detection for cyclical structures
          JSON.stringify(data[i])
          makeEnv(data[i], envKey + '_', env)
        } catch (ex) {
          // usually these are package objects.
          // just get the path and basic details.
          var d = data[i]
          makeEnv(
            { name: d.name, version: d.version, path: d.path },
            envKey + '_',
            env
          )
        }
      } else {
        env[envKey] = String(data[i])
        env[envKey] = env[envKey].indexOf('\n') !== -1
                        ? JSON.stringify(env[envKey])
                        : env[envKey]
      }
    }
  }

  if (prefix !== 'npm_package_') return env

  prefix = 'npm_config_'
  var pkgConfig = {}
  var keys = npm.config.keys
  var pkgVerConfig = {}
  var namePref = data.name + ':'
  var verPref = data.name + '@' + data.version + ':'

  keys.forEach(function (i) {
    // in some rare cases (e.g. working with nerf darts), there are segmented
    // "private" (underscore-prefixed) config names -- don't export
    if (i.charAt(0) === '_' && i.indexOf('_' + namePref) !== 0 || i.match(/:_/)) {
      return
    }
    var value = npm.config.get(i)
    if (value instanceof Stream || Array.isArray(value)) return
    if (i.match(/umask/)) value = umask.toString(value)
    if (!value) value = ''
    else if (typeof value === 'number') value = '' + value
    else if (typeof value !== 'string') value = JSON.stringify(value)

    value = value.indexOf('\n') !== -1
          ? JSON.stringify(value)
          : value
    i = i.replace(/^_+/, '')
    var k
    if (i.indexOf(namePref) === 0) {
      k = i.substr(namePref.length).replace(/[^a-zA-Z0-9_]/g, '_')
      pkgConfig[k] = value
    } else if (i.indexOf(verPref) === 0) {
      k = i.substr(verPref.length).replace(/[^a-zA-Z0-9_]/g, '_')
      pkgVerConfig[k] = value
    }
    var envKey = (prefix + i).replace(/[^a-zA-Z0-9_]/g, '_')
    env[envKey] = value
  })

  prefix = 'npm_package_config_'
  ;[pkgConfig, pkgVerConfig].forEach(function (conf) {
    for (var i in conf) {
      var envKey = (prefix + i)
      env[envKey] = conf[i]
    }
  })

  return env
}

function cmd (stage) {
  function CMD (args, cb) {
    npm.commands['run-script']([stage].concat(args), cb)
  }
  CMD.usage = usage(stage, 'npm ' + stage + ' [-- <args>]')
  var installedShallow = require('./completion/installed-shallow.js')
  CMD.completion = function (opts, cb) {
    installedShallow(opts, function (d) {
      return d.scripts && d.scripts[stage]
    }, cb)
  }
  return CMD
}
