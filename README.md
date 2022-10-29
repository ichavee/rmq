ฟีเจอร์
- reconnect อัตโนมัติเมื่อ connection ขาด (ตั้งจำนวนครั้ง และ back-off ได้)
- มี buffer เก็บ message ที่ถูก publish ขณะที่ offline อยู่ และนำไป publish อีกครั้งอัตโนมัติเมื่อ connection กลับมา
- ประกาศ topology ด้วย JSON ครั้งเดียว แต่ library จะนำไป apply ให้ต่อ
- สร้าง topology ให้ใหม่ทุกครั้งที่ reconnect เพื่อป้องกันกรณีที่ RabbitMQ restart กลับมาแบบว่างเปล่า

Functions

rmq.init() ใช้สำหรับตั้งค่า client
```
rmq.init(configuration);
```

Configuration options

connection :
- uri เช่น 'amqp://guest:guest@127.0.0.1:5672/%2F'
- prefetch เป็นจำนวน message ที่ consume ได้ในเวลาเดียวกัน โดยที่ยังไม่ ack
- retryLimit จำนวนครั้งที่จะ reconnect หากไม่จำกัดจำนวนตั้งเป็น -1 (default : -1)
- waitMin ช่วงเวลาต่ำสุดที่จะรอจนกว่าจะ reconnect ครั้งต่อไป (default : 1000)
- waitMax ช่วงเวลาสูงสุดที่จะรอจนกว่าจะ reconnect ครั้งต่อไป (default : 15000)
- waitIncrement ระยะเวลารอที่จะถูกเพิ่มในแต่ละครั้งที่ reconnect (default : 500)


rmq.connect() ใช้สำหรับเริ่มการเชื่อมต่อ RabbitMQ server
```
rmq.connect();
```

rmq.handleQueue(quename, handler) ใช้สำหรับเขียนฟังก์ชั่นรับการเข้ามาของ message จาก queue ที่กำหนด
```
rmq.handleQueue('deerQ', function(msg) {
    console.log('consume from queue deerQ --> ' + msg.content);
    msg.ack();
});
```


Events

#connected เกิดขึ้นเมื่อ client เชื่อมต่อ RabbitMQ server
```
rmq.on('connected', function() {
    console.log('rabbitmq connected..');
});
```

#closed เกิดขึ้นเมื่อ client ขาดการเชื่อมต่อจาก RabbitMQ server
```
rmq.on('closed', function() {
    console.log('rabbitmq closed..');
});
```

#unhandled เกิดขึ้นเมื่อ message ที่เข้ามา ไม่ถูก handle จาก handler function ใดเลย
```
rmq.on('unhandled', function(msg) {
    msg.ack();
});
```

ตัวอย่างการใช้งาน

```
const RMQ = require('rmq');
let c = 0;

rmq = RMQ.create({
    connection: {
        uri: 'amqp://guest:guest@127.0.0.1:5672/%2F',
        prefetch : 10
    },
    exchanges: [
        { name: 'deerEx', type: 'topic', autoDelete: false },
    ],
    queues: [
        { name: 'deerQ', autoDelete: false, subscribe: true },
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
    msg.ack();
});

rmq.connect();
```

ตัวอย่างการใช้ Dead Letter

กรณีที่ nack และต้องการให้ message ส่งไป dead letter exchange จะต้อง nack ด้วย parameter {requeue: false} ไม่เช่นนั้น message จะถูกส่งกลับไป exchange เดิม และวนกลับมาหา consumer นี้อีก

```
const RMQ = require('rmq');
let c = 0;

rmq = RMQ.create({
    connection: {
        uri: 'amqp://guest:guest@127.0.0.1:5672/%2F'
    },
    exchanges: [
        { name: 'deerEx', type: 'topic', autoDelete: false },
        { name: 'deerDLEx', type: 'topic', autoDelete: false }
    ],
    queues: [
        { name: 'deerQ', autoDelete: false, subscribe: true, deadLetterExchange: 'deerDLEx', deadLetterRoutingKey: 'msg.dead' },
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
    console.log('consume from queue deerQ and then nack --> ' + msg.content);
    msg.nack({requeue: false});
});

rmq.connect();
```

