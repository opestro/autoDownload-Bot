import express from 'express';
import mongoose from 'mongoose';
import { Telegraf } from 'telegraf';
import { IgApiClient } from 'instagram-private-api';
import ytdl from '@distube/ytdl-core';
import fbvid from 'fb-video-downloader';
import getVideoId from 'get-video-id'; // Import get-video-id
import fs from 'fs';
import path from 'path';
import config from './config.js'; // Import config
import InstagramHandler from './instagram-handler.js'; // Import Instagram handler
import User from './models/user.js'; // Import User model
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { ttdl, ytmp3, ytmp4, fbdl, igdl } from 'ruhend-scraper'; // Import ruhend-scraper functions
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';

const app = express();
const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN); // Use the token from config
const ig = new IgApiClient();

// Initialize Instagram handler
const instagramHandler = new InstagramHandler();

// Define __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Logging configuration
const LOG_LEVELS = {
    INFO: 'INFO',
    ERROR: 'ERROR',
    DEBUG: 'DEBUG',
    WARNING: 'WARNING'
};

const logFilePath = path.join(__dirname, 'logs', 'app.log');

// Ensure logs directory exists
if (!fs.existsSync(path.join(__dirname, 'logs'))) {
    fs.mkdirSync(path.join(__dirname, 'logs'));
}

// Enhanced logging function
function log(level, message, data = null) {
    const timestamp = new Date().toISOString();
    let logEntry = `${timestamp} - ${level} - ${message}`;
    
    // Add data if provided
    if (data) {
        // If data is an error object, get the stack trace
        if (data instanceof Error) {
            logEntry += `\nStack Trace: ${data.stack}`;
        } else {
            // Safely stringify objects, limiting their size
            const dataString = JSON.stringify(data, null, 2).substring(0, 1000);
            logEntry += `\nData: ${dataString}`;
        }
    }
    
    logEntry += '\n';

    // Write to file
    fs.appendFileSync(logFilePath, logEntry, 'utf8');
    
    // Also log to console in development
    if (process.env.NODE_ENV !== 'production') {
        console.log(logEntry);
    }
}

// Utility functions for different log levels
const logger = {
    info: (message, data = null) => log(LOG_LEVELS.INFO, message, data),
    error: (message, error = null) => log(LOG_LEVELS.ERROR, message, error),
    debug: (message, data = null) => log(LOG_LEVELS.DEBUG, message, data),
    warning: (message, data = null) => log(LOG_LEVELS.WARNING, message, data)
};

// Set the path for ffmpeg
ffmpeg.setFfmpegPath(ffmpegPath);

// MongoDB connection
mongoose.connect(config.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 5000, // Try to connect for 5 seconds
    socketTimeoutMS: 10000, // Close sockets after 45 seconds of inactivity
})
.then(() => {
    logger.info('MongoDB connected successfully');
})
.catch(err => {
    logger.error('MongoDB connection error', err);
});

// Cookie rotation pool
const cookiePool = [];
let currentCookieIndex = 0;

async function getNextCookie() {
    try {
        // If pool is empty or we need to refresh
        if (cookiePool.length === 0 || currentCookieIndex >= cookiePool.length) {
            const newCookies = await getYouTubeCookies();
            if (newCookies) {
                cookiePool.push(newCookies);
            }
            currentCookieIndex = 0;
        }

        // Return next cookie from pool
        const cookie = cookiePool[currentCookieIndex];
        currentCookieIndex = (currentCookieIndex + 1) % cookiePool.length;
        return cookie;
    } catch (error) {
        logger.error('Error in cookie rotation', error);
        return null;
    }
}

// Function to get YouTube cookies dynamically
async function getYouTubeCookies() {
    try {
        const response = await fetch('https://www.youtube.com', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        return response.headers.get('set-cookie');
    } catch (error) {
        logger.error('Error fetching cookies', error);
        return null;
    }
}

// Telegram Bot Commands
bot.start((ctx) => {
    ctx.reply('Welcome! Share a video link to download.');
});

// Utility function to check URL type
function getUrlType(url) {
    const youtubeRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/;
    const facebookRegex = /^(https?:\/\/)?(www\.)?(facebook\.com|fb\.watch)\/.+$/;
    const linkedinRegex = /^(https?:\/\/)?(www\.)?(linkedin\.com)\/.+$/;
    const tiktokRegex = /^(https?:\/\/)?(www\.)?(tiktok\.com)\/.+$/;

    if (youtubeRegex.test(url)) return 'youtube';
    if (facebookRegex.test(url)) return 'facebook';
    if (linkedinRegex.test(url)) return 'linkedin';
    if (tiktokRegex.test(url)) return 'tiktok';
    return 'unknown';
}

// Logging function
function logMessage(message) {
    const timestamp = new Date().toISOString();
    const logEntry = `${timestamp} - ${message}\n`;
    fs.appendFileSync(logFilePath, logEntry, 'utf8');
}

// Example usage of the logging function
logMessage('Server started');

// Handle YouTube downloads
async function downloadYouTubeVideo(url, ctx) {
    let videoPath = null;
    
    try {
        logger.info(`Starting download process for URL: ${url}`);

        if (!ytdl.validateURL(url)) {
            logger.warning('Invalid YouTube URL attempted', { url });
            throw new Error('Invalid YouTube URL');
        }

        const info = await ytdl.getInfo(url);
        logger.debug('Video info retrieved', {
            title: info.videoDetails.title,
            duration: info.videoDetails.lengthSeconds,
            author: info.videoDetails.author
        });

        const videoTitle = info.videoDetails.title;

        // Ask user to choose format
        const formatKeyboard = {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '🎵 Audio Only', callback_data: 'audio' },
                        { text: '🎬 Video + Audio', callback_data: 'videoaudio' }
                    ]
                ]
            }
        };

        await ctx.reply('Choose format:', formatKeyboard);

        // Handle audio only selection
        bot.action('audio', async (ctx) => {
            try {
                logger.info('Audio format selected', {
                    userId: ctx.from?.id,
                    videoTitle
                });
                
                await ctx.editMessageText('⏳ Processing audio...');
                const audioFormat = ytdl.chooseFormat(info.formats, { quality: 'highestaudio' });
                
                logger.debug('Selected audio format', {
                    format: audioFormat.qualityLabel,
                    container: audioFormat.container,
                    bitrate: audioFormat.audioBitrate
                });

                const audioPath = path.join(__dirname, 'downloads', `${videoTitle}.mp3`);
                
                if (!fs.existsSync(path.join(__dirname, 'downloads'))) {
                    fs.mkdirSync(path.join(__dirname, 'downloads'));
                }

                const audioStream = ytdl(url, { format: audioFormat });
                const writeStream = fs.createWriteStream(audioPath);

                writeStream.on('finish', async () => {
                    await ctx.reply('🎵 Sending audio...');
                    await ctx.replyWithAudio({ 
                        source: audioPath,
                        caption: `${videoTitle}\n\n@${ctx.from.username || ctx.from.id}`
                    });
                    fs.unlinkSync(audioPath);
                    await ctx.reply('✅ Done!');
                });

                audioStream.pipe(writeStream);
            } catch (error) {
                logger.error('Audio processing failed', error);
                await ctx.reply('❌ Failed to process audio');
            }
        });

        // Handle video selection
        bot.action('videoaudio', async (ctx) => {
            try {
                logger.info('Video format selection started', {
                    userId: ctx.from?.id,
                    videoTitle
                });

                // Get both video-only and video+audio formats
                const formats = info.formats.filter(format => format.hasVideo);
                
                // Group formats by quality and prefer formats with audio
                const qualityMap = new Map();
                formats.forEach(format => {
                    const quality = format.qualityLabel || format.quality;
                    if (!qualityMap.has(quality) || format.hasAudio) {
                        qualityMap.set(quality, format);
                    }
                });

                // Convert to array and sort by quality
                const sortedFormats = Array.from(qualityMap.values()).sort((a, b) => {
                    const aQuality = parseInt(a.qualityLabel) || 0;
                    const bQuality = parseInt(b.qualityLabel) || 0;
                    return bQuality - aQuality;
                });

                logger.debug('Available video formats after sorting', {
                    formats: sortedFormats.map(f => ({
                        quality: f.qualityLabel || f.quality,
                        container: f.container,
                        hasAudio: f.hasAudio,
                        hasVideo: f.hasVideo
                    }))
                });

                // Create quality options
                const qualityOptions = sortedFormats.map((format, index) => ({
                    text: `📺 ${format.qualityLabel || format.quality}${format.hasAudio ? '' : ' (audio merged)'}`,
                    callback_data: `quality_${index}`
                }));

                const qualityKeyboard = {
                    reply_markup: {
                        inline_keyboard: qualityOptions.map(option => [option])
                    }
                };

                await ctx.editMessageText('Select video quality:', qualityKeyboard);

                // Handle quality selection
                qualityOptions.forEach((option, index) => {
                    bot.action(`quality_${index}`, async (ctx) => {
                        try {
                            await ctx.editMessageText('⏳ Processing video...');
                            const format = sortedFormats[index];
                            const videoPath = path.join(__dirname, 'downloads', `${videoTitle}.${format.container}`);
                            const audioPath = path.join(__dirname, 'downloads', `${videoTitle}.mp3`);
                            const mergedVideoPath = path.join(__dirname, 'downloads', `${videoTitle}_merged.mp4`); // Temporary output path for merged video

                            if (format.hasAudio) {
                                // If format has audio, download directly
                                const videoStream = ytdl(url, { format });
                                const writeStream = fs.createWriteStream(videoPath);

                                writeStream.on('finish', async () => {
                                    await ctx.reply('🎬 Sending video...');
                                    await ctx.replyWithVideo({ 
                                        source: videoPath,
                                        caption: `${videoTitle}\n\n@${ctx.from.username || ctx.from.id}`
                                    });
                                    fs.unlinkSync(videoPath);
                                    await ctx.reply('✅ Done!');
                                });

                                videoStream.pipe(writeStream);
                            } else {
                                // If no audio, get best audio and merge
                                const audioFormat = ytdl.chooseFormat(info.formats, { 
                                    quality: 'highestaudio',
                                    filter: 'audioonly'
                                });

                                const videoStream = ytdl(url, { format });
                                const audioStream = ytdl(url, { format: audioFormat });

                                // Download video and audio streams
                                const videoWriteStream = fs.createWriteStream(videoPath);
                                const audioWriteStream = fs.createWriteStream(audioPath);

                                videoStream.pipe(videoWriteStream);
                                audioStream.pipe(audioWriteStream);

                                // Wait for both streams to finish
                                Promise.all([
                                    new Promise((resolve) => videoWriteStream.on('finish', resolve)),
                                    new Promise((resolve) => audioWriteStream.on('finish', resolve))
                                ]).then(() => {
                                    // Merge audio and video
                                    ffmpeg(videoPath)
                                        .addInput(audioPath)
                                        .outputOptions('-c:v libx264') // Use H.264 codec for video
                                        .outputOptions('-c:a aac') // Use AAC codec for audio
                                        .outputOptions('-b:a 192k') // Set audio bitrate
                                        .outputOptions('-preset fast') // Use a fast preset for encoding
                                        .save(mergedVideoPath) // Save the merged file to a different path
                                        .on('end', async () => {
                                            await ctx.reply('🎬 Sending merged video...');
                                            await ctx.replyWithVideo({ 
                                                source: mergedVideoPath,
                                                caption: `${videoTitle}\n\n@${ctx.from.username || ctx.from.id}`
                                            });
                                            fs.unlinkSync(videoPath); // Clean up video file
                                            fs.unlinkSync(audioPath); // Clean up audio file
                                            fs.unlinkSync(mergedVideoPath); // Clean up merged video file
                                            await ctx.reply('✅ Done!');
                                        })
                                        .on('error', (error) => {
                                            logger.error('Error merging video and audio', error);
                                            ctx.reply('❌ Failed to process video');
                                        });
                                });
                            }
                        } catch (error) {
                            logger.error('Error processing video', error);
                            await ctx.reply('❌ Failed to process video');
                        }
                    });
                });
            } catch (error) {
                logger.error('Video format selection failed', error);
                await ctx.reply('❌ Failed to get video qualities');
            }
        });

    } catch (error) {
        logger.error('Download process failed', {
            error: error.message,
            url,
            userId: ctx.from?.id
        });
        await ctx.reply('❌ Invalid YouTube link');
    }
}

async function downloadFacebookVideo(url, ctx) {
    try {
        console.log('Starting Facebook download process for URL:', url);

        const res = await fbdl(url);
        const data = res.data;

        if (!data) {
            throw new Error('Failed to download Facebook video');
        }

        console.log('Facebook video info retrieved:', data);

        // Assuming the first video in the data array is the one we want
        const videoUrl = data[0].url; // Adjust based on the actual structure of the response
        const videoTitle = `facebook_video_${Date.now()}`;
        const videoPath = path.join(__dirname, 'downloads', `${videoTitle}.mp4`);

        // Create downloads directory if it doesn't exist
        if (!fs.existsSync(path.join(__dirname, 'downloads'))) {
            fs.mkdirSync(path.join(__dirname, 'downloads'));
        }

        // Download the video file
        const response = await fetch(videoUrl);

        if (!response.ok) {
            throw new Error(`Failed to fetch video: ${response.status} ${response.statusText}`);
        }

        const buffer = await response.buffer();
        fs.writeFileSync(videoPath, buffer);

        // Send video to user
        await ctx.reply('Video downloaded! Sending it to you...');
        await ctx.replyWithVideo({ source: videoPath });

        // Clean up: delete the video file
        fs.unlinkSync(videoPath);
        console.log('Local video file deleted after sending.');

    } catch (error) {
        console.error('Error downloading Facebook video:', error);
        await ctx.reply(`Sorry, there was an error downloading the Facebook video: ${error.message}`);
    }
}

// Handle Instagram downloads
async function downloadInstagramVideo(url, ctx) {
    try {
        console.log('Starting Instagram download process for URL:', url);

        const res = await igdl(url);
        const data = await res.data;

        if (!data || data.length === 0) {
            throw new Error('Failed to download Instagram video');
        }

        console.log('Instagram video info retrieved:', data);

        // Assuming the first media in the data array is the one we want
        const videoUrl = data[0].url; // Adjust based on the actual structure of the response
        const videoTitle = `instagram_video_${Date.now()}`;
        const videoPath = path.join(__dirname, 'downloads', `${videoTitle}.mp4`);

        // Create downloads directory if it doesn't exist
        if (!fs.existsSync(path.join(__dirname, 'downloads'))) {
            fs.mkdirSync(path.join(__dirname, 'downloads'));
        }

        // Download the video file
        const response = await fetch(videoUrl);

        if (!response.ok) {
            throw new Error(`Failed to fetch video: ${response.status} ${response.statusText}`);
        }

        const buffer = await response.buffer();
        fs.writeFileSync(videoPath, buffer);

        // Send video to user
        await ctx.reply('Video downloaded! Sending it to you...');
        await ctx.replyWithVideo({ source: videoPath });

        // Clean up: delete the video file
        fs.unlinkSync(videoPath);
        console.log('Local video file deleted after sending.');

    } catch (error) {
        console.error('Error downloading Instagram video:', error);
        await ctx.reply(`Sorry, there was an error downloading the Instagram video: ${error.message}`);
    }
}

// LinkedIn video download function
async function downloadLinkedInVideo(url, ctx) {
    try {
        await ctx.reply('Fetching LinkedIn video information...');

        const videoIdInfo = getVideoId(url);

        if (!videoIdInfo || videoIdInfo.service !== 'linkedin') {
            throw new Error('Invalid LinkedIn video URL');
        }

        // Here you would need to implement the logic to fetch the video using the videoId
        // Since we cannot directly download LinkedIn videos, you may need to use an API or another method

        // For demonstration, let's assume we have a function to get the video URL
        const videoUrl = await fetchLinkedInVideoUrl(videoIdInfo.id); // Placeholder function

        if (!videoUrl) {
            throw new Error('No downloadable video URL found');
        }

        const videoTitle = `linkedin_video_${Date.now()}`;
        const videoPath = path.join(__dirname, 'downloads', `${videoTitle}.mp4`);

        // Create downloads directory if it doesn't exist
        if (!fs.existsSync(path.join(__dirname, 'downloads'))) {
            fs.mkdirSync(path.join(__dirname, 'downloads'));
        }

        // Download video using fetch
        const response = await fetch(videoUrl);
        const buffer = await response.buffer();
        fs.writeFileSync(videoPath, buffer);

        // Send video to user
        await ctx.reply('Video downloaded! Sending it to you...');
        await ctx.replyWithVideo({ source: videoPath });

        // Save download record to database
        const user = await User.findOne({ telegramId: ctx.from.id });
        if (user) {
            user.downloads.push(url);
            await user.save();
        }

        // Clean up: delete the video file
        fs.unlinkSync(videoPath);

    } catch (error) {
        console.error('Error downloading LinkedIn video:', error);
        ctx.reply('Sorry, there was an error downloading the LinkedIn video. Please make sure the video is public and try again.');
    }
}

// Handle TikTok downloads
async function downloadTikTokVideo(url, ctx) {
    try {
        console.log('Starting TikTok download process for URL:', url);

        // Download TikTok video
        const data = await ttdl(url);

        if (!data) {
            throw new Error('Failed to download TikTok video');
        }

        console.log('TikTok video info retrieved:', data.title);

        const videoTitle = data.title.replace(/[^\w\s]/gi, '');
        const videoPath = path.join(__dirname, 'downloads', `${videoTitle}.mp4`);

        // Create downloads directory if it doesn't exist
        if (!fs.existsSync(path.join(__dirname, 'downloads'))) {
            fs.mkdirSync(path.join(__dirname, 'downloads'));
        }

        // Download the video file
        const videoUrl = data.video; // Use the video link from the response
        const response = await fetch(videoUrl);

        if (!response.ok) {
            throw new Error(`Failed to fetch video: ${response.status} ${response.statusText}`);
        }

        const buffer = await response.buffer();
        fs.writeFileSync(videoPath, buffer);

        // Send video to user
        await ctx.reply('Video downloaded! Sending it to you...');
        await ctx.replyWithVideo({ source: videoPath });

        // Clean up: delete the video file
        fs.unlinkSync(videoPath);
        console.log('Local video file deleted after sending.');

    } catch (error) {
        console.error('Error downloading TikTok video:', error);
        await ctx.reply(`Sorry, there was an error downloading the TikTok video: ${error.message}`);
    }
}


// Update the text message handler
bot.on('text', async (ctx) => {
    const messageText = ctx.message.text;

    // Handle /start command
    if (messageText === '/start') {
        return;
    }

    try {
        // Check if user exists in database, if not create new user
        let user = await User.findOne({ telegramId: ctx.from.id });
        if (!user) {
            user = new User({
                telegramId: ctx.from.id,
                downloads: []
            });
            await user.save();
        }

        // Handle different URL types
        const urlType = getUrlType(messageText);
        switch (urlType) {
            case 'youtube':
                await ctx.reply('Processing your YouTube video download request...');
                await downloadYouTubeVideo(messageText, ctx);
                break;

            case 'facebook':
                await ctx.reply('Processing your Facebook video download request...');
                await downloadFacebookVideo(messageText, ctx);
                break;

            case 'linkedin':
                await ctx.reply('Processing your LinkedIn video download request...');
                await downloadLinkedInVideo(messageText, ctx);
                break;

            case 'tiktok':
                await ctx.reply('Processing your TikTok video download request...');
                await downloadTikTokVideo(messageText, ctx);
                break;

            default:
                await ctx.reply('Sorry, this link is not supported yet. Currently, I can only download YouTube, Facebook, LinkedIn, and TikTok videos.');
        }

    } catch (error) {
        logger.error('Error processing message', error);
        await ctx.reply('Sorry, something went wrong. Please try again.');
    }
});

// Instagram Integration
app.post('/instagram', async (req, res) => {
    const { userId, videoUrl } = req.body;
    // Logic to download video from Instagram
    // Send video back to user via Telegram
    res.send('Video sent to Telegram!');
});

// Add Instagram commands to bot
bot.command('connect_instagram', async (ctx) => {
    try {
        await ctx.reply('Please send your Instagram username to connect your account.');

        // Set up a listener for the next message
        bot.on('text', async (innerCtx) => {
            const instagramUsername = innerCtx.message.text;

            // Update user record with Instagram ID
            const user = await User.findOneAndUpdate(
                { telegramId: innerCtx.from.id },
                { instagramId: instagramUsername },
                { new: true, upsert: true }
            );

            await innerCtx.reply(
                'Thanks! Your Instagram account has been connected. ' +
                'You can now share videos with our Instagram bot to receive them here.'
            );
        });
    } catch (error) {
        console.error('Error connecting Instagram:', error);
        await ctx.reply('Sorry, there was an error connecting your Instagram account. Please try again.');
    }
});

// Start Instagram message polling
async function startInstagramPolling() {
    try {
        await instagramHandler.login();

        // Poll for new messages every minute
        setInterval(async () => {
            await instagramHandler.handleDirectMessages(bot);
        }, 60000);
    } catch (error) {
        console.error('Error in Instagram polling:', error);
    }
}

// Graceful shutdown handler
process.once('SIGINT', () => {
    bot.stop('SIGINT');
    mongoose.connection.close();
    process.exit(0);
});

process.once('SIGTERM', () => {
    bot.stop('SIGTERM');
    mongoose.connection.close();
    process.exit(0);
});

// Update the start function to include Express server
async function start() {
    try {
        await bot.launch();
        await startInstagramPolling();

        // Start Express server
        app.listen(config.PORT, () => {
            logger.info(`Server started on port ${config.PORT}`);
        });

        console.log('Bot, Instagram handler, and Express server are running');
    } catch (error) {
        logger.error('Error starting services', error);
    }
}

start();

export default downloadYouTubeVideo;

// Update error handling
process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection', {
        reason,
        promise
    });
});

// Example log rotation (to prevent log files from growing too large)
function rotateLogFile() {
    try {
        if (fs.existsSync(logFilePath)) {
            const stats = fs.statSync(logFilePath);
            const fileSizeInMB = stats.size / (1024 * 1024);
            
            if (fileSizeInMB > 10) { // Rotate when file size exceeds 10MB
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const newPath = `${logFilePath}.${timestamp}`;
                fs.renameSync(logFilePath, newPath);
                logger.info('Log file rotated');
            }
        }
    } catch (error) {
        console.error('Error rotating log file:', error);
    }
}

// Check log file size every hour
setInterval(rotateLogFile, 60 * 60 * 1000);
