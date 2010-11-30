/* 
 *
 *  hwknd.com
 *
 *  (c) 2010 stagas
 *
 */

/*
 * config
 */

// enter your hostname if you're not using polla (github.com/stagas/node-polla)
var HOST = process.env.POLLA_HOST || 'localhost'
  , PORT = process.env.POLLA_PORT || 8888
  , DEBUG = 1 // 0 (none), 1 (debug) or 2 (debug with line number)

// setup
var sys = require('sys')
  , fs = require('fs')
  , path = require('path')
  , dirname = path.dirname(__filename) + '/'
  , crypto = require('crypto')
  , querystring = require('querystring')
  , colors = require('colors')
  , connect = require('connect')
  , meryl = require('meryl')
  , jade = require('jade')
  , db = require('chaos')(dirname + 'db')
  , request = require('request')
  , Recaptcha = require('recaptcha').Recaptcha
  , rcPublicKey = require('./rckeys').rcPublicKey
  , rcPrivateKey = require('./rckeys').rcPrivateKey

// log functions
var log = function() {
  if (DEBUG) {
    var msgarr = Array.prototype.slice.call(arguments).join(' ')
    if (DEBUG>1) {
      try {
        throw new Error()
      } catch(e) {
        var line = e.stack.split('\n')[3].split(':')[1]
        sys.print('    '.slice(line.length) + line.cyan + ' ')
      }
    }
    sys.print(
      ('[' + (new Date).toUTCString() + '] ').grey
    )
    console.log(msgarr)
  }
}

// Handle uncaught errors
process.on('uncaughtException', function (err) {
  log('Caught exception: '.red, err.message)
  var s = err.stack.split('\n')
  s.shift()
  console.log(s)
})

/*
 *  main app
 */
 
process.title = HOST

var hwknd = {}
hwknd = {
  projects: {}
, owner: {}
, contributors: {}
, languages: {}
, sorted: []
}

var rateLimit = 60
  , running = 0
  , queue = []
  , refreshing = false
  , frontpage = ''
  , html = {}
  , users = {}
  , banned = {}
  , week = 7 * 24 * 60 * 60 * 1000

function hex(s) {
  return '#' + crypto.createHash('sha1').update(s).digest('hex').substr(0,6)
}

function render(view, locals) {
  return html[view].call(context, locals)
}

var context = { render: render, hex: hex }

var views = fs.readdirSync(dirname + 'views')
views.forEach(function(view) {
  html[view.replace('.jade', '')] = jade.compile(fs.readFileSync(dirname + 'views/' + view, 'utf8'))
  fs.watchFile(dirname + 'views/' + view, function() {
    html[view.replace('.jade', '')] = jade.compile(fs.readFileSync(dirname + 'views/' + view, 'utf8'))
    frontpage = render('layout', { view: 'home', locals: hwknd })
  })
})

var repoRegexp = new RegExp('([^a-zA-Z0-9_\\-\.])', 'g')
  , userRegexp = new RegExp('([^a-zA-Z0-9-])', 'g')
  
function q() {
  var args = Array.prototype.slice.call(arguments)
  queue.push(args)
}

function flush() {
  if (running > rateLimit - 10 || !queue.length) return
  
  var args = queue.shift()
    , ctx = args.shift()
    , f = args.shift()
  
  f.apply(ctx, args)

  running++

  setTimeout(function() {
    running--
  }, 60 * 1000)
}

setTimeout(function() {
  
  setInterval(function() {
    flush()
  }, 1000)

}, 1 * 1000) // ***** NOTICE: this should be 60 * 1000 *****

function repoSort(a, b) {
  return (new Date(b.created_at) - new Date(a.created_at))
}

function langSort(a, b) {
  return (b.v - a.v)
}

function deleteRepo(name) {
  delete hwknd.projects[name]
  delete hwknd.contributors[name]
  delete hwknd.languages[name]
}

function refreshRepos() {
  if (refreshing) return
  refreshing = true

  log('Refreshing repos...')
  
  var owner
    , counter = Object.keys(hwknd.projects).length

  if (!counter) {
    refreshing = false
    return saveDb()
  }
  
  for (var name in hwknd.projects) {
    owner = hwknd.projects[name].owner
    ;(function(owner, name) {
      q(this, request,
        {uri: 'http://github.com/api/v2/json/repos/show/'
              + owner + '/'
              + name.split('/')[1]}, function(err, res, json) {
              
        var data
        if (!err) {
          try {
            data = JSON.parse(json)
          } catch(e) {
            log('error parsing repo')
          }

          if (data) {
            if (typeof data.repository !== 'undefined') {
              hwknd.projects[name] = data.repository
              if (((new Date(hwknd.projects[name].created_at) - new Date(Date.now() - week))) < 0) {
                deleteRepo(name)
              }
            }
          
            if (typeof data.error !== 'undefined') {
              if (!!~data.error.indexOf('not found')) {
                deleteRepo(name)
              }
            }
          }
        } else {
          log('error fetching repo', err)
        }

        counter--
        if (!counter) {
          getOwners()
        }
      })
    }(owner, name))
  }
}

function getOwners() {
  var repo
    , counter = Object.keys(hwknd.projects).length
  
  if (!counter) {
    refreshing = false
    return saveDb()
  }
  
  for (var name in hwknd.projects) {
    repo = hwknd.projects[name]
    ;(function(repo, name) {
      q(this, request,
        {uri: 'http://github.com/api/v2/json/user/show/'
              + repo.owner}, function(err, res, json) {
              
        var data
        if (!err) {
          try {
            data = JSON.parse(json)
          } catch(e) {
            log('error parsing owner')
          }
          if (data && typeof data.user !== 'undefined') hwknd.owner[name] = data.user
        } else {
          log('error fetching owner', err)
        }
        counter--
        if (!counter) {
          getContributors()
        }
      })
    }(repo, name))
  }
}

function getContributors() {
  var repo
    , counter = Object.keys(hwknd.projects).length
  
  if (!counter) {
    refreshing = false
    return saveDb()
  }
  
  for (var name in hwknd.projects) {
    repo = hwknd.projects[name]
    ;(function(repo, name) {
      q(this, request,
        {uri: 'http://github.com/api/v2/json/repos/show/'
              + repo.owner + '/'
              + repo.name + '/contributors'}, function(err, res, json) {
              
        var data
        if (!err) {
          try {
            data = JSON.parse(json)
          } catch(e) {
            log('error parsing contributors')
          }
          
          if (data && typeof data.contributors !== 'undefined') hwknd.contributors[name] = data.contributors
        } else {
          log('error fetching repo contributors', err)
        }
        counter--
        if (!counter) {
          getLanguages()
        }
      })
    }(repo, name))
  }
}

function getLanguages() {
  var repo
    , counter = Object.keys(hwknd.projects).length

  if (!counter) {
    refreshing = false
    return saveDb()
  }
    
  for (var name in hwknd.projects) {
    repo = hwknd.projects[name]
    ;(function(repo, name) {
      q(this, request,
        {uri: 'http://github.com/api/v2/json/repos/show/'
              + repo.owner + '/'
              + repo.name + '/languages'}, function(err, res, json) {

        var data
        if (!err) {
          try {
            data = JSON.parse(json)
          } catch(e) {
            log('error parsing languages')
          }
          
          if (data && typeof data.languages !== 'undefined' && Object.keys(data.languages).length) {
            var arr = []
            for (var k in data.languages) {
              arr.push({k: k, v: data.languages[k]})
            }
            arr.sort(langSort)
            hwknd.languages[name] = arr
          }
        } else {
          log('error fetching repo language', err)
        }
        counter--
        if (!counter) {
          refreshing = false
          saveDb()
        }
      })
    }(repo, name))
  }
}


function postProcess() {
  var arr = []
  
  for (var name in hwknd.projects) {
    arr.push({name: name, created_at: (hwknd.projects[name].created_at || 0)})
  }

  arr.sort(repoSort)
  hwknd.sorted = arr
  
  frontpage = render('layout', { view: 'home', locals: hwknd })
}

function saveDb() {
  postProcess()

  db.set('hwknd', JSON.stringify(hwknd), function(err) {
    db.set('banned', JSON.stringify(banned), function(err) {
      log('Saved db')
      setTimeout(function() {
        refreshRepos()
      }, 2 * 60 * 1000)
    })
  })
}

db.getorsetget('hwknd', JSON.stringify(hwknd), function(err, json) {
  if (err) return
  
  var data
  try {
    data = JSON.parse(json)
  } catch(e) {
    data = hwknd
  }

  hwknd = data
  
  postProcess()
  
  refreshRepos()
})

db.getorsetget('banned', JSON.stringify(banned), function(err, json) {
  if (err) return
  
  var data
  try {
    data = JSON.parse(json)
  } catch(e) {
    data = banned
  }

  banned = data
})

// Meryl handlers

meryl

.p('GET *', connect.staticProvider(dirname + 'public'))

.h('GET /create', function(req, res) {
  res.send( render('layout', { 
    view: 'create'
  , locals: { recaptcha: (new Recaptcha(rcPublicKey, rcPrivateKey)).toHTML() } 
  }))
})

.h('POST /create', function(req, res) {
  var data = querystring.parse(req.postdata.toString())
    , rcData = {
        remoteip: req.headers.ip
      , challenge: data.recaptcha_challenge_field
      , response: data.recaptcha_response_field
      }
    , recaptcha = new Recaptcha(rcPublicKey, rcPrivateKey, rcData)

  if (typeof data.repo !== 'undefined' &&
      typeof data.user !== 'undefined' &&
      data.repo.length &&
      data.user.length) {
      
    data.repo = data.repo.replace(repoRegexp, '')
    data.user = data.user.replace(userRegexp, '')

    log(req.headers.ip.magenta, 'Attempting to create'.yellow, data.repo, 'by', data.user)
    
    if (data.repo.length && data.user.length && data.user.substr(0,1) !== '-' &&
        typeof hwknd.projects[data.user + '/' + data.repo] === 'undefined') {
      
      recaptcha.verify(function(success, error_code) {
        if (success) {
          hwknd.projects[data.user + '/' + data.repo] = {
            owner: data.user
          }
          log(req.headers.ip.magenta, 'Created'.green, data.repo, 'by', data.user)
          res.send( render('layout', { view: 'thanks', locals: {} }) )
          postProcess()
          refreshRepos()
        } else {
          log(req.headers.ip.magenta, 'Captcha failed:'.red, data.repo, 'by', data.user)
        
          res.send( render('layout', {
            view: 'create'
          , locals: { error: 'Something went wrong, you should try again'
                    , recaptcha: (new Recaptcha(rcPublicKey, rcPrivateKey)).toHTML() } 
          }))
        }
      })
    } else {
      log(req.headers.ip.magenta, 'Failed to create:'.red, data.repo, 'by', data.user)
    
      res.send( render('layout', { 
        view: 'create'
      , locals: { error: 'Something went wrong, you should try again'
                , recaptcha: (new Recaptcha(rcPublicKey, rcPrivateKey)).toHTML() } 
      }))
    }
  } else {
    log(req.headers.ip.magenta, 'Failed to create:'.red, data.repo, 'by', data.user)
  
    res.send( render('layout', { 
      view: 'create'
    , locals: { error: 'Something went wrong, you should try again'
              , recaptcha: (new Recaptcha(rcPublicKey, rcPrivateKey)).toHTML() } 
    }))
  }
})

.h('GET /help', function(req, res) {
  res.send(render('layout', { view: 'help', locals: {} }) )
})

.h('GET /about', function(req, res) {
  res.send(render('layout', { view: 'about', locals: {} }) )
})

.h('GET /', function(req, res) {
  res.send(frontpage)
})

var server = connect.createServer(

  // copy ip address to req.headers.ip for polla and logger
  function(req, res, next) {
    if (typeof req.headers.ip === 'undefined')
      req.headers.ip = req.connection.remoteAddress
      
    next()
  }
  
, connect.logger({
    format: 
      '[:date] '
    + ':req[ip] '.magenta
    + ':method '.yellow
    + ':status '.white
    + ':url '.green
    + ':user-agent :referrer :http-version'.grey 
  })
  
, function(req, res, next) {
    var ip = req.headers.ip

    if (typeof banned[ip] !== 'undefined') {
      if (Date.now() - banned[ip] > 3 * 60 * 60 * 1000) {
        delete banned[ip]
        log('UNBANNED:'.cyan, ip)
      } else {
        log('HAS BEEN BANNED:'.yellow, ip)
      }
    }
    
    if (typeof users[ip] === 'undefined' && typeof banned[ip] === 'undefined') {
      users[ip] = { visits: 0, timeout: null }
    }
    
    if (typeof banned[ip] === 'undefined') {
      users[ip].visits++
      clearTimeout(users[ip].timeout)
      users[ip].timeout = setTimeout(function() {
        delete users[ip]
      }, 5 * 1000)
    }
    
    if (typeof banned[ip] !== 'undefined' || users[ip].visits > 30) {
      if (typeof banned[ip] === 'undefined' && users[ip].visits > 60) {
        banned[ip] = Date.now()
        log('BANNED:'.yellow, ip)
      }
      log('FLOODER:'.red, ip)
      res.writeHead(503, {'Content-Type': 'text/html'})
      res.end('<h1>Service unavailable</h1>')
    } else {
      next()
    }
  }
  
, meryl.cgi()
)

var retries = 0
  , maxRetries = 50
  , startedTimeout = null
  , serverStarted = function() {
      log( 'Server started: '.green
         + HOST.white
         + ' | Port: '
         + PORT.toString().yellow
         + '\n-----------------------------------------------------------------------------------------'.grey
         )
    }

startedTimeout = setTimeout(serverStarted, 3000)
    
server.on('error', function (e) {
  if (e.errno == require('constants').EADDRINUSE) {
    clearTimeout(startedTimeout)
    
    retries++
    if (retries >= maxRetries) {
      log('Giving up, exiting.')
      return process.exit()
    }
    
    log('Address in use, retrying...')
    
    setTimeout(function () {
      server.close()
      server.listen(PORT, HOST)

      clearTimeout(startedTimeout)
      startedTimeout = setTimeout(serverStarted, 3000)
      
    }, 1000)
    
  }
})

server.listen(PORT, HOST)

// soft kill
process.on('SIGINT', function() {
  console.log('Killing me softly')
  server.close()
  process.exit()
})

