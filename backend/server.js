import express from "express";
import nodemailer from "nodemailer";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from 'url';
import { MongoClient, ObjectId } from "mongodb"; // Added ObjectId import
import bcrypt from "bcryptjs";
import multer from 'multer';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cors({
    origin: 'http://127.0.0.1:5500',
    credentials: true
}));

app.use(express.urlencoded({ extended: true }));

// Configure multer
const upload = multer({
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'), false);
        }
    }
});

// MongoDB Connection
let db;
let client;

const username = process.env.DB_USERNAME;
const password = process.env.DB_PASSWORD;

const connectDB = async () => {
    try {
        const options = {
            connectTimeoutMS: 5000,
            socketTimeoutMS: 30000,
            serverSelectionTimeoutMS: 5000,
            maxPoolSize: 10
        };

        client = new MongoClient(
            process.env.MONGODB_URI || `mongodb+srv://${username}:${password}@cluster1.mlorw.mongodb.net/`,
            options
        );

        await client.connect();
        db = client.db('dream_foundation');
        console.log('MongoDB connected successfully');

        await db.command({ ping: 1 });
        console.log('Successfully pinged deployment');

        // Create indexes
        await db.collection('admin').createIndex({ email: 1 }, { unique: true });
        await db.collection('events').createIndex({ date: 1 });
        await db.collection('event_history').createIndex({ timestamp: -1 });

    } catch (err) {
        console.error('MongoDB connection error:', err);

        if (err.name === 'MongoServerError') {
            console.error('Authentication failed. Please check:');
            console.error('1. Your MongoDB username/password in the connection string');
            console.error('2. That your IP is whitelisted in MongoDB Atlas');
            console.error('3. That the database user has correct privileges');
        }

        if (client) await client.close();
        process.exit(1);
    }
};

// ==================== EVENT MANAGEMENT ENDPOINTS ====================

// Create new event
app.post('/api/events/create', async (req, res) => {
    try {
        const { title, date, time, location, description, adminEmail } = req.body;
        
        if (!title || !date || !time || !location || !adminEmail) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        const event = {
            title,
            date: new Date(date),
            time,
            location,
            description: description || '',
            createdBy: adminEmail,
            createdAt: new Date(),
            updatedAt: new Date()
        };

        const result = await db.collection('events').insertOne(event);
        
        // Record history
        await db.collection('event_history').insertOne({
            eventId: result.insertedId.toString(),
            eventTitle: title,
            eventDate: new Date(date),
            adminEmail,
            action: 'created',
            timestamp: new Date()
        });

        res.status(201).json({
            success: true,
            message: 'Event created successfully',
            eventId: result.insertedId
        });
    } catch (err) {
        console.error('Event creation error:', err);
        res.status(500).json({ success: false, message: 'Failed to create event' });
    }
});

// Get all events
app.get('/api/events', async (req, res) => {
    try {
        const events = await db.collection('events')
            .find()
            .sort({ date: 1 })
            .toArray();
        
        // Convert MongoDB ObjectId to string for client-side
        const formattedEvents = events.map(event => ({
            ...event,
            _id: event._id.toString(),
            date: event.date.toISOString().split('T')[0]
        }));

        res.json({ success: true, events: formattedEvents });
    } catch (err) {
        console.error('Error fetching events:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch events' });
    }
});

// Update event
app.put('/api/events/:id', async (req, res) => {
    try {
        const eventId = req.params.id;
        const { title, date, time, location, description, adminEmail } = req.body;
        
        if (!ObjectId.isValid(eventId)) {
            return res.status(400).json({ success: false, message: 'Invalid event ID' });
        }

        const updateData = {
            title,
            date: new Date(date),
            time,
            location,
            description,
            updatedBy: adminEmail,
            updatedAt: new Date()
        };

        const result = await db.collection('events').updateOne(
            { _id: new ObjectId(eventId) },
            { $set: updateData }
        );
        
        if (result.matchedCount === 0) {
            return res.status(404).json({ success: false, message: 'Event not found' });
        }
        
        // Record history
        await db.collection('event_history').insertOne({
            eventId: eventId,
            eventTitle: title,
            eventDate: new Date(date),
            adminEmail,
            action: 'updated',
            timestamp: new Date()
        });

        res.json({ success: true, message: 'Event updated successfully' });
    } catch (err) {
        console.error('Event update error:', err);
        res.status(500).json({ success: false, message: 'Failed to update event' });
    }
});

// Delete event
app.delete('/api/events/:id', async (req, res) => {
    try {
        const eventId = req.params.id;
        
        if (!ObjectId.isValid(eventId)) {
            return res.status(400).json({ success: false, message: 'Invalid event ID' });
        }

        // First get the event before deleting to record history
        const event = await db.collection('events').findOne({ _id: new ObjectId(eventId) });
        
        if (!event) {
            return res.status(404).json({ success: false, message: 'Event not found' });
        }

        const result = await db.collection('events').deleteOne({ _id: new ObjectId(eventId) });
        
        if (result.deletedCount === 0) {
            return res.status(404).json({ success: false, message: 'Event not found' });
        }

        // Record history
        await db.collection('event_history').insertOne({
            eventId: eventId,
            eventTitle: event.title,
            eventDate: event.date,
            adminEmail: req.body.adminEmail || 'system',
            action: 'deleted',
            timestamp: new Date()
        });

        res.json({ success: true, message: 'Event deleted successfully' });
    } catch (err) {
        console.error('Event deletion error:', err);
        res.status(500).json({ success: false, message: 'Failed to delete event' });
    }
});

// Get event history
app.get('/api/events/history', async (req, res) => {
    try {
        const history = await db.collection('event_history')
            .find()
            .sort({ timestamp: -1 })
            .limit(50)
            .toArray();
        
        // Format dates for display
        const formattedHistory = history.map(record => ({
            ...record,
            eventDate: record.eventDate.toISOString().split('T')[0],
            timestamp: record.timestamp.toISOString()
        }));

        res.json({ success: true, history: formattedHistory });
    } catch (err) {
        console.error('Error fetching event history:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch event history' });
    }
});

// ==================== ADMIN AUTHENTICATION ENDPOINTS ====================

// Admin Login Endpoint
app.post('/api/admin/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({
            success: false,
            message: 'Email and password are required'
        });
    }

    try {
        const admin = await db.collection('admin').findOne({ email });

        if (!admin) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        const isMatch = await bcrypt.compare(password, admin.password);
        if (!isMatch) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        res.json({
            success: true,
            message: 'Login successful',
            user: { 
                _id: admin._id.toString(),
                email: admin.email,
                name: admin.name || 'Admin'
            }
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({
            success: false,
            message: 'Server error during authentication'
        });
    }
});

// ==================== EMAIL ENDPOINTS ====================

// Email API
const transporter = nodemailer.createTransport({
    secure: true,
    host: 'smtp.gmail.com',
    port: 465,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

app.post('/api/send-email', (req, res) => {
    const { to, subject, html } = req.body;

    if (!to || !subject || !html) {
        return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const mailOptions = { to, subject, html };

    transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
            console.error('Error sending email:', error);
            return res.status(500).json({ success: false, message: 'Error sending email' });
        }
        console.log('Email sent:', info.response);
        res.status(200).json({ success: true, message: 'Email sent successfully' });
    });
});



// Get user statistics
app.get('/api/users/stats', async (req, res) => {
    try {
        const totalUsers = await db.collection('users').countDocuments();
        const activeAdmins = await db.collection('admin').countDocuments({ status: 'active' });
        
        // Count new users this month
        const startOfMonth = new Date();
        startOfMonth.setDate(1);
        startOfMonth.setHours(0, 0, 0, 0);
        
        const newUsers = await db.collection('users').countDocuments({
            createdAt: { $gte: startOfMonth }
        });

        res.json({
            success: true,
            stats: {
                totalUsers,
                activeAdmins,
                newUsers
            }
        });
    } catch (err) {
        console.error('Error fetching user stats:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch user stats' });
    }
});

// Create new admin
app.post('/api/admin/create', async (req, res) => {
    try {
        const { name, email, password, role, createdBy } = req.body;
        
        if (!name || !email || !password || !role) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        // Check if admin already exists
        const existingAdmin = await db.collection('admin').findOne({ email });
        if (existingAdmin) {
            return res.status(400).json({ success: false, message: 'Admin with this email already exists' });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        const admin = {
            name,
            email,
            password: hashedPassword,
            role,
            status: 'active',
            createdBy,
            createdAt: new Date(),
            updatedAt: new Date()
        };

        await db.collection('admin').insertOne(admin);
        
        res.status(201).json({
            success: true,
            message: 'Admin created successfully'
        });
    } catch (err) {
        console.error('Admin creation error:', err);
        res.status(500).json({ success: false, message: 'Failed to create admin' });
    }
});

// Get all admins
app.get('/api/admin/list', async (req, res) => {
    try {
        const admins = await db.collection('admin')
            .find()
            .sort({ createdAt: -1 })
            .toArray();
        
        // Remove passwords from response
        const sanitizedAdmins = admins.map(admin => {
            const { password, ...adminWithoutPassword } = admin;
            return {
                ...adminWithoutPassword,
                _id: admin._id.toString()
            };
        });

        res.json({ success: true, admins: sanitizedAdmins });
    } catch (err) {
        console.error('Error fetching admins:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch admins' });
    }
});

// Get single admin
app.get('/api/admin/:id', async (req, res) => {
    try {
        const adminId = req.params.id;
        
        if (!ObjectId.isValid(adminId)) {
            return res.status(400).json({ success: false, message: 'Invalid admin ID' });
        }

        const admin = await db.collection('admin').findOne({ _id: new ObjectId(adminId) });
        
        if (!admin) {
            return res.status(404).json({ success: false, message: 'Admin not found' });
        }

        // Remove password from response
        const { password, ...adminWithoutPassword } = admin;

        res.json({
            success: true,
            admin: {
                ...adminWithoutPassword,
                _id: admin._id.toString()
            }
        });
    } catch (err) {
        console.error('Error fetching admin:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch admin' });
    }
});

// Delete admin
app.delete('/api/admin/:id', async (req, res) => {
    try {
        const adminId = req.params.id;
        const { deletedBy } = req.body;
        
        if (!ObjectId.isValid(adminId)) {
            return res.status(400).json({ success: false, message: 'Invalid admin ID' });
        }

        // Prevent deleting yourself
        const currentAdminEmail = deletedBy;
        const adminToDelete = await db.collection('admin').findOne({ _id: new ObjectId(adminId) });
        
        if (adminToDelete.email === currentAdminEmail) {
            return res.status(400).json({ success: false, message: 'You cannot delete your own account' });
        }

        const result = await db.collection('admin').deleteOne({ _id: new ObjectId(adminId) });
        
        if (result.deletedCount === 0) {
            return res.status(404).json({ success: false, message: 'Admin not found' });
        }

        res.json({ success: true, message: 'Admin deleted successfully' });
    } catch (err) {
        console.error('Error deleting admin:', err);
        res.status(500).json({ success: false, message: 'Failed to delete admin' });
    }
});




// ==================== ADMIN PROFILE ENDPOINTS ====================

// Get admin profile data
app.get('/api/admin/profile', async (req, res) => {
    try {
        const email = req.query.email;
        if (!email) {
            return res.status(400).json({ success: false, message: 'Email is required' });
        }

        const admin = await db.collection('admin').findOne({ email });
        if (!admin) {
            return res.status(404).json({ success: false, message: 'Admin not found' });
        }

        // Return profile data without password
        const profileData = {
            _id: admin._id.toString(),
            name: admin.name || '',
            surname: admin.surname || '',
            email: admin.email,
            image: admin.image || 'images/admin-avatar.png'
        };

        res.json({ success: true, profile: profileData });
    } catch (err) {
        console.error('Error fetching admin profile:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch admin profile' });
    }
});

// Update admin profile
app.put('/api/admin/profile', async (req, res) => {
    try {
        const { _id, name, surname, email, currentPassword, newPassword } = req.body;
        
          if (!ObjectId.isValid(_id)) {
            return res.status(400).json({ success: false, message: 'Invalid admin ID' });
        }
        
        if (!name || !surname || !email) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        // Validate email format
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ success: false, message: 'Invalid email format' });
        }

        // Check if email is being changed to one that already exists
        if (email !== req.body.originalEmail) {
            const emailExists = await db.collection('admin').findOne({ email });
            if (emailExists) {
                return res.status(400).json({ success: false, message: 'Email already in use' });
            }
        }

        // Get the current admin data
        const admin = await db.collection('admin').findOne({ _id: new ObjectId(_id) });
        if (!admin) {
            return res.status(404).json({ success: false, message: 'Admin not found' });
        }

        // Prepare update data
        const updateData = {
            name,
            surname,
            email,
            updatedAt: new Date()
        };

        // Handle password change if requested
        if (newPassword) {
            if (!currentPassword) {
                return res.status(400).json({ 
                    success: false, 
                    message: 'Current password is required to change password' 
                });
            }

            // Verify current password
            const isMatch = await bcrypt.compare(currentPassword, admin.password);
            if (!isMatch) {
                return res.status(401).json({ 
                    success: false, 
                    message: 'Current password is incorrect' 
                });
            }

            // Hash new password
            const hashedPassword = await bcrypt.hash(newPassword, 10);
            updateData.password = hashedPassword;
        }

        // Update the admin in database
        const result = await db.collection('admin').updateOne(
            { _id: new ObjectId(_id) },
            { $set: updateData }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ success: false, message: 'Admin not found' });
        }

        // Return updated profile data without password
        const updatedAdmin = await db.collection('admin').findOne({ _id: new ObjectId(_id) });
        const profileData = {
            _id: updatedAdmin._id.toString(),
            name: updatedAdmin.name,
            surname: updatedAdmin.surname,
            email: updatedAdmin.email,
            image: updatedAdmin.image || 'images/admin-avatar.png'
        };

        res.json({ 
            success: true, 
            message: 'Profile updated successfully',
            profile: profileData
        });

    } catch (err) {
        console.error('Error updating admin profile:', err);
        res.status(500).json({ success: false, message: 'Failed to update admin profile' });
    }
});

// Update admin profile image
app.post('/api/admin/profile/image', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ 
                success: false, 
                message: 'No image file provided' 
            });
        }

        const { _id } = req.body;
        
        if (!_id) {
            return res.status(400).json({ 
                success: false, 
                message: 'Admin ID is required' 
            });
        }

        // Convert image to base64 for storage
        const imageBase64 = req.file.buffer.toString('base64');
        const imageSrc = `data:${req.file.mimetype};base64,${imageBase64}`;

        // Update the admin image in database
        const result = await db.collection('admin').updateOne(
            { _id: new ObjectId(_id) },
            { $set: { 
                image: imageSrc,
                updatedAt: new Date() 
            }}
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Admin not found' 
            });
        }

        res.json({ 
            success: true, 
            message: 'Profile image updated successfully',
            image: imageSrc
        });

    } catch (err) {
        console.error('Error updating admin profile image:', err);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to update profile image',
            error: err.message 
        });
    }
});


// Update the existing admin creation endpoint
app.post('/api/admin/create', async (req, res) => {
    try {
        const { name, surname, email, password, role, createdBy } = req.body;
        
        if (!name || !surname || !email || !password || !role) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        // Check if admin already exists
        const existingAdmin = await db.collection('admin').findOne({ email });
        if (existingAdmin) {
            return res.status(400).json({ success: false, message: 'Admin with this email already exists' });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        const admin = {
            name,
            surname,
            email,
            password: hashedPassword,
            role,
            status: 'active',
            image: 'images/admin-avatar.png', // Default image
            createdBy,
            createdAt: new Date(),
            updatedAt: new Date()
        };

        await db.collection('admin').insertOne(admin);
        
        res.status(201).json({
            success: true,
            message: 'Admin created successfully'
        });
    } catch (err) {
        console.error('Admin creation error:', err);
        res.status(500).json({ success: false, message: 'Failed to create admin' });
    }
});




// ==================== STATIC FILES ====================

// Serve static files
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, '../')));

// ==================== SERVER STARTUP ====================

// Connect to DB and start server
connectDB().then(() => {
    app.listen(PORT, () => {
        console.log(`Server is running on port: ${PORT}`);
    });
}).catch((err) => {
    console.error('Failed to connect to MongoDB:', err);
    process.exit(1);
});