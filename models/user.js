import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
    telegramId: String,
    instagramId: String,
    downloads: [String],
    createdAt: {
        type: Date,
        default: Date.now
    }
});

export default mongoose.model('User', userSchema);