const RMQ = require('../index');
let c = 0;
rmq = RMQ.create({
    connection: {
        uri: 'amqp://admin:password@127.0.0.1:5672/%2F',
        prefetch : 10
    },
    exchanges: [
        { name: 'deerEx', type: 'topic', autoDelete: false },
        { name: 'deerDLEx', type: 'topic', autoDelete: false }
    ],
    queues: [
        { name: 'deerQ', autoDelete: false, subscribe: true, deadLetterExchange: 'deerDLEx' },
    ],
    bindings: [
        { exchange: 'deerEx', target: 'deerQ', keys: ['#'] },
    ]
});

rmq.on('connected', function() {
    console.log('rabbitmq connected..');
});

rmq.on('closed', function() {
    console.log('rabbitmq closed..');
});

setInterval(() => {
    console.log('publish..');
    rmq.publish('deerEx','home.bedroom.temp',++c,{});
},1000);

rmq.handleQueue('deerQ',function(msg) {
    console.log('consume from queue deerQ --> ' + msg.content);
    msg.nack({requeue: false});
});

rmq.connect();
