const Denque = require("denque");
const AMQP = require('amqplib');
const events = require('events');

function debug_log(content) {
    //console.log(content);
}

let RMQ = function(config) {
    this.config = config;
    this.conn = null;
    this.amqp = {};
    this.contimer = 0;
    this.connecting = false;
    this.connected = false;
    this.handler = {};
    this.outqueue = new Denque();

    this.heartbeat = this.config.connection.heartbeat || 5000;
    this.retryLimit = this.config.connection.retryLimit || -1;
    this.waitMin = this.config.connection.waitMin || 1000;
    this.waitMax = this.config.connection.waitMax || 15000;
    this.waitIncrement = this.config.connection.waitIncrement || 500;

    this.nextRetryTimestamp = 0;
    this.currentWait = this.waitMin;
    this.currentRetry = this.retryLimit;
}

RMQ.prototype = new events.EventEmitter;

RMQ.prototype.amqpMessageHandler = function(msg) {
    let unhandled = true;
    let that = this;
    
    msg.ack = function() {
        that.amqp.ch.ack(msg);
    };

    msg.nack = function(option = {}) {
        let allUpTo = option.allUpTo === undefined? false : option.allUpTo;
        let requeue = option.requeue === undefined? true : option.requeue;

        that.amqp.ch.nack(msg, allUpTo, requeue);
    };

    if (msg && msg.fields.consumerTag) {
        if (this.handler && Array.isArray(this.handler[msg.fields.consumerTag]) ) {
            for (let func of (this.handler[msg.fields.consumerTag])) {
                if (typeof(func) == 'function') {
                    unhandled = false;
                    func(msg);
                }
            }
        }
    }

    if (unhandled) {
        RMQ.prototype.emit('unhandled', msg);
    }
}

RMQ.prototype.handleQueue = function(qname, handler) {
    if (!this.handler[qname]) {
        this.handler[qname] = [];
    }
    this.handler[qname].push(handler);
}

RMQ.prototype.setTopology = function() {
    let that = this;

    function setExchange() {
        return new Promise((resolve, reject) => {
            let exList = that.config.exchanges || [];
            let count = 0;
            for (let ex of exList) {
                let opt = {... ex};
                delete opt.name;
                delete opt.type;

                that.amqp.ch.assertExchange(ex.name, ex.type, opt).then(() => {
                    count++;
                    if (count >= exList.length) {
                        resolve();
                    }
                }).catch(e => {
                    reject(e);
                });
            }
        });
    }

    function setQueue() {
        return new Promise((resolve, reject) => {
            let qList = that.config.queues || [];
            let count = 0;
            for (let q of qList) {
                let opt = {... q};
                delete opt.name;
                delete opt.subscribe;

                that.amqp.ch.assertQueue(q.name, opt).then(() => {
                    if (q.subscribe) {
                        opt.consumerTag = q.name;
                        that.amqp.ch.consume(q.name, that.amqpMessageHandler.bind(that), opt).then(() => {

                        }).catch(e => {

                        });
                    }

                    count++;
                    if (count >= qList.length) {
                        resolve();
                    }
                }).catch(e => {
                    reject(e);
                });
            }
        });
    }

    function setBinding() {
        return new Promise((resolve, reject) => {
            let bindList = [];
            let rawBindList = that.config.bindings || [];

            for (let p of rawBindList) {
                let keys = p.keys;
                if (Array.isArray(keys)) {
                    for (r of keys) {
                        let s = {... p};
                        s.key = r;
                        delete s.keys;
                        bindList.push(s);
                    }
                }
                else {
                    let s = {... p};
                    s.key = keys.toString();
                    delete s.keys;
                    bindList.push(s);
                }
            }

            let count = 0;
            for (let b of bindList) {
                let opt = {... b};
                delete opt.target;
                delete opt.exchange;
                delete opt.key;

                that.amqp.ch.bindQueue(b.target, b.exchange, b.key, opt).then(() => {
                    count++;
                    if (count >= bindList.length) {
                        resolve();
                    }
                }).catch(e => {
                    //console.log(e)
                    reject(e);
                });
            }
        });
    }

    return new Promise((resolve, reject) => {
        if (that.connected) {
            setExchange().then(()=> {
                debug_log('set Ex');
                setQueue().then(() => {
                    debug_log('set Q');

                    setBinding().then(() => {
                        debug_log('set Binding');
                        resolve();
                    }).catch(e => {
                        debug_log('set Binding failed')
                    });   
                }).catch(e => {
                    debug_log('set Q failed')
                });
            }).catch(e=>{
                debug_log('set Ex failed')

            });
        }
        else {
            reject();
        }
    });
}


RMQ.prototype.do_connect = function() {
    let that = this;

    return new Promise((resolve, reject) => {
        that.connecting = true;
        AMQP.connect(that.config.connection.uri).then(function(conn) {
            that.amqp.conn = conn;
            conn.createChannel().then(function(ch) {
                that.amqp.ch = ch;

                if (that.config.connection.prefetch) {
                    that.amqp.ch.prefetch(that.config.connection.prefetch)
                }

                ch.on('close', function() {
                    that.connected = false;
                    RMQ.prototype.emit('closed');
                    setTimeout(() => {
                        that.connect();
                    }, that.waitMin);
                });

                that.connected = true;
                that.connecting = false;

                RMQ.prototype.emit('connected');
                that.currentWait = that.waitMin;

                that.setTopology().then(() => {
                    RMQ.prototype.emit('configured');
                    that.flushout().then(() => {
                        debug_log('Flushout');
                        resolve(ch);
                    }).catch(e => {
                        debug_log('Flushout failed');
                        reject();
                    });   
                }).catch(e=> {
                    reject('set topology failed');
                });

            });
        }).catch(function(e) {
            that.connecting = false;
            reject('connect failed');
        });
    });
}

RMQ.prototype.connect = function() {
    let that = this;

    function setIntervalAndExecute(fn, t) {
        fn();
        return(setInterval(fn, t));
    }

    this.contimer = setIntervalAndExecute(() => {
        if (!that.connecting && !that.connected && Date.now()>=that.nextRetryTimestamp && that.currentRetry!=0) {
            debug_log('retry connect..: '+that.currentRetry);
            that.do_connect().then(() => {
                that.currentWait = that.waitMin;
                that.currentRetry = that.retryLimit;
            }).catch(e => {
                //console.log(e);
                if (that.currentWait > that.waitMax) that.currentWait = that.waitMax
                that.nextRetryTimestamp = Date.now() + that.currentWait;
                that.currentWait += that.waitIncrement;

                if (that.currentRetry >= 0) that.currentRetry--;
            });
        }
    }, that.heartbeat);
 }

RMQ.prototype.publish = function(exname, rountingkey, content, option) {
    let that = this;
    let result, buffer, strcontent;

    if (typeof(content)=='object') {
        strcontent = JSON.stringify(content);
    }
    else {
        strcontent = String(content);
    }

    if (typeof(content) != 'buffer') {
        buffer = Buffer.from(strcontent);
    }
    else buffer = content;

    if (this.amqp && this.amqp.ch && this.connected) {
        try {
            result = that.amqp.ch.publish(exname, rountingkey, buffer, option);
        } catch(e) {
            that.outqueue.push({exname, rountingkey, buffer, option});
        }
    }
    else {
        that.outqueue.push({exname, rountingkey, buffer, option});
    }
}

RMQ.prototype.publishToQueue = function(qname, content, option) {
    let that = this;
    let result, buffer, strcontent;

    if (typeof(content)=='object') {
        strcontent = JSON.stringify(content);
    }
    else {
        strcontent = String(content);
    }

    if (typeof(content) != 'buffer') {
        buffer = Buffer.from(strcontent);
    }
    else buffer = content;

    if (this.amqp && this.amqp.ch && this.connected) {
        try {
            result = that.amqp.ch.sendToQueue(qname, buffer, option);
        } catch(e) {
            that.outqueue.push({qname, buffer, option});
        }
    }
    else {
        that.outqueue.push({exname, rountingkey, buffer, option});
    }
}

RMQ.prototype.flushout = function() {
    let that = this;
    return new Promise((resolve, reject) => {
        let result;
        if (that.amqp && that.amqp.ch && that.connected) {
            let obj;
            let timer = 0;
            let queue = this.outqueue;

            function stop() {
                if (timer!=0) clearInterval(timer);
                timer = 0;
            }

            timer = setInterval( () => {
                obj = queue.shift();
                if (obj != undefined) {
                    if (obj.exname) {
                        result = this.amqp.ch.publish(obj.exname, obj.rountingkey, obj.buffer, obj.option);        
                    }
                    else if (obj.qname) {
                        result = this.amqp.ch.sendToQueue(obj.qname, obj.buffer, obj.option);        
                    }

                    if (!result) {
                        queue.unshift(obj);
                        stop();
                        reject();
                    }
                }
                else {
                    stop();
                    resolve();
                }
            },10);
        }
        else {

        }
    });
}

RMQ.prototype.parseContent = function(msg) {
    let jsoncontent;
    try {
        jsoncontent = JSON.parse(msg.content.toString());
    }
    catch(e) {
        jsoncontent = undefined;
    }
    return jsoncontent;
}

RMQ.prototype.connected = function() {
    return this.connected;
}

module.exports.create = function(config) {
    return new RMQ(config);
}
