import dotenv from 'dotenv';
dotenv.config();

export default {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    MONGODB_URI: process.env.MONGODB_URI,
    PORT: process.env.PORT || 3000,
    INSTAGRAM_USERNAME: process.env.INSTAGRAM_USERNAME,
    INSTAGRAM_PASSWORD: process.env.INSTAGRAM_PASSWORD
}; 