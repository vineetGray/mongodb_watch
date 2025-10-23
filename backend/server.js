import express from 'express';
import { MongoClient, ObjectId } from 'mongodb';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

let db;
let lastCheckTime = new Date();
let orderCache = new Map();

async function connectDB() {
  try {
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    db = client.db();
    console.log(' Connected to MongoDB');
    
    // Initialize polling
    startPolling();
  } catch (error) {
    console.error(' MongoDB connection failed:', error);
  }
}

// Polling instead of change streams
function startPolling() {
  setInterval(async () => {
    try {
      await checkForChanges();
    } catch (error) {
      console.error('Polling error:', error);
    }
  }, 1000); // Check every 1 second
}

async function checkForChanges() {
 
  const orders = await db.collection('orders').find({}).sort({ createdAt: -1 }).toArray();
  

  const newOrders = orders.filter(order => 
    new Date(order.createdAt) > lastCheckTime && !orderCache.has(order._id.toString())
  );
  

  orders.forEach(order => {
    const orderId = order._id.toString();
    const cachedOrder = orderCache.get(orderId);
    
    if (cachedOrder && cachedOrder.status !== order.status) {
  
      console.log(`🔄 Status changed: ${orderId} ${cachedOrder.status} → ${order.status}`);
      io.emit('statusUpdated', {
        orderId: order._id,
        newStatus: order.status,
        order: order
      });
      
    
      handleAutoProgress(order);
    }
    
 
    orderCache.set(orderId, order);
  });

  newOrders.forEach(order => {
    console.log(`📦 New order: ${order.customerName}`);
    io.emit('orderCreated', order);
    orderCache.set(order._id.toString(), order);
 
    setTimeout(async () => {
      try {
        await db.collection('orders').updateOne(
          { _id: order._id },
          { $set: { status: 'processing', updatedAt: new Date() } }
        );
      } catch (error) {
        console.error('Error updating order:', error);
      }
    }, 2000);
  });
  
  lastCheckTime = new Date();
}

function handleAutoProgress(order) {
  if (order.status === 'processing') {
    setTimeout(async () => {
      try {
        await db.collection('orders').updateOne(
          { _id: order._id },
          { $set: { status: 'shipped', updatedAt: new Date() } }
        );
      } catch (error) {
        console.error('Error shipping order:', error);
      }
    }, 3000);
  } else if (order.status === 'shipped') {
    setTimeout(async () => {
      try {
        await db.collection('orders').updateOne(
          { _id: order._id },
          { $set: { status: 'delivered', updatedAt: new Date() } }
        );
      } catch (error) {
        console.error('Error delivering order:', error);
      }
    }, 3000);
  }
}

app.get('/api/orders', async (req, res) => {
  try {
    const orders = await db.collection('orders').find({}).sort({ createdAt: -1 }).toArray();
    res.json(orders);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/orders', async (req, res) => {
  try {
    const order = {
      customerName: req.body.customerName,
      product: req.body.product,
      quantity: req.body.quantity || 1,
      price: req.body.price || 0,
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await db.collection('orders').insertOne(order);
    const newOrder = { ...order, _id: result.insertedId };
    
    res.json(newOrder);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Socket.io (same as before)
io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(` Using POLLING mode (works with single MongoDB instance)`);
  connectDB();
});