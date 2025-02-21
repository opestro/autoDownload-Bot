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

const app = express();
const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN); // Use the token from config
const ig = new IgApiClient();

// Initialize Instagram handler
const instagramHandler = new InstagramHandler();

// MongoDB connection
mongoose.connect(config.MONGODB_URI);

// Cookie rotation pool
const cookiePool = [];
let currentCookieIndex = 0;

// Fix for __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
        console.error('Error in cookie rotation:', error);
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
        console.error('Error fetching cookies:', error);
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

// Handle video downloads
async function downloadYouTubeVideo(url, ctx) {
    let videoPath = null;
    
    try {
        console.log('Starting download process for URL:', url);

        // Validate YouTube URL
        if (!ytdl.validateURL(url)) {
            throw new Error('Invalid YouTube URL');
        }

        // Get video info
        console.log('Fetching video info...');
        const info = await ytdl.getInfo(url);
        console.log('Video info retrieved:', info.videoDetails.title);

        // Send initial status message
        const statusMessage = await ctx.reply('Starting video download... 0%');

        // Choose format
        const format = ytdl.chooseFormat(info.formats, { 
            quality: 'highest',
            filter: 'audioandvideo'
        });

        if (!format) {
            throw new Error('No suitable format found');
        }

        console.log('Selected format:', format.qualityLabel, format.container);

        const videoTitle = info.videoDetails.title.replace(/[^\w\s]/gi, '');
        videoPath = path.join(__dirname, 'downloads', `${videoTitle}.${format.container}`);

        // Create downloads directory if it doesn't exist
        if (!fs.existsSync(path.join(__dirname, 'downloads'))) {
            fs.mkdirSync(path.join(__dirname, 'downloads'));
        }

        // Download the video
        const videoStream = ytdl(url, {
            format: format,
            filter: 'audioandvideo'
        });

        // Track last update time to avoid too frequent updates
        let lastUpdateTime = Date.now();

        // Add progress tracking
        videoStream.on('progress', async (chunkLength, downloaded, total) => {
            const now = Date.now();
            // Update status message every 2 seconds
            if (now - lastUpdateTime > 2000) {
                const percent = (downloaded / total * 100).toFixed(1);
                try {
                    await statusMessage.edit(`Downloading: ${percent}%`);
                    lastUpdateTime = now;
                } catch (err) {
                    console.error('Error updating status message:', err);
                }
            }
        });

        return new Promise((resolve, reject) => {
            const writeStream = fs.createWriteStream(videoPath);
            
            writeStream.on('finish', async () => {
                console.log('Download completed successfully.');
                try {
                    // Update status message
                    await statusMessage.edit('Download complete! Uploading to Telegram...');

                    // Send video to Telegram
                    const sentMessage = await ctx.replyWithVideo({ 
                        source: videoPath,
                        caption: `${info.videoDetails.title}\n\nRequested by: @${ctx.from.username || ctx.from.id}`
                    });

                    // Clean up: delete the local file
                    fs.unlinkSync(videoPath);
                    console.log('Local video file deleted after sending.');

                    // Update final status
                    await statusMessage.edit('✅ Video successfully uploaded to Telegram!');
                    
                    resolve(sentMessage);
                } catch (error) {
                    console.error('Error sending video:', error);
                    reject(error);
                }
            });

            writeStream.on('error', (error) => {
                console.error('Error writing file:', error);
                reject(error);
            });

            videoStream.pipe(writeStream);
        });

    } catch (error) {
        console.error('Error in downloadYouTubeVideo:', error);
        
        // Clean up if file exists
        if (videoPath && fs.existsSync(videoPath)) {
            try {
                fs.unlinkSync(videoPath);
                console.log('Cleaned up incomplete download file.');
            } catch (cleanupError) {
                console.error('Error cleaning up file:', cleanupError);
            }
        }

        let errorMessage = 'Sorry, there was an error downloading the video. ';
        if (error.message.includes('Invalid YouTube URL')) {
            errorMessage += 'Please make sure you provided a valid YouTube URL.';
        } else if (error.message.includes('No suitable format found')) {
            errorMessage += 'Could not find a suitable video format.';
        } else {
            errorMessage += 'Please try again later or try a different video.';
        }
        
        await ctx.reply(errorMessage);
        throw error;
    }
}

// Facebook video download function
async function downloadFacebookVideo(url, ctx) {
    try {
        await ctx.reply('Fetching Facebook video information...');
        
        console.log('Fetching video info for URL:', url); // Log the URL being fetched
        const videoInfo = await fbvid.getInfo(url);
        
        console.log('Video Info:', videoInfo); // Log the video info response

        const videoUrl = videoInfo.download.hd || videoInfo.download.sd;
        
        if (!videoUrl) {
            throw new Error('No downloadable video URL found');
        }

        const videoTitle = `fb_video_${Date.now()}`;
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
        console.error('Error downloading Facebook video:', error);
        ctx.reply('Sorry, there was an error downloading the Facebook video. Please make sure the video is public and try again.');
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

// TikTok video download function
async function downloadTikTokVideo(url, ctx) {
    try {
        await ctx.reply('Fetching TikTok video information...');

        const videoIdInfo = getVideoId(url);
        
        if (!videoIdInfo || videoIdInfo.service !== 'tiktok') {
            throw new Error('Invalid TikTok video URL');
        }

        // Here you would need to implement the logic to fetch the video using the videoId
        // Since we cannot directly download TikTok videos, you may need to use an API or another method

        // For demonstration, let's assume we have a function to get the video URL
        const videoUrl = await fetchTikTokVideoUrl(videoIdInfo.id); // Placeholder function

        if (!videoUrl) {
            throw new Error('No downloadable video URL found');
        }

        const videoTitle = `tiktok_video_${Date.now()}`;
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
        console.error('Error downloading TikTok video:', error);
        ctx.reply('Sorry, there was an error downloading the TikTok video. Please make sure the video is public and try again.');
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
        console.error('Error processing message:', error);
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
            console.log(`Server is running on port ${config.PORT}`);
        });
        
        console.log('Bot, Instagram handler, and Express server are running');
    } catch (error) {
        console.error('Error starting services:', error);
    }
}

start();

export default downloadYouTubeVideo;
