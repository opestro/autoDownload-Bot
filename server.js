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

const app = express();
const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN); // Use the token from config
const ig = new IgApiClient();

// Initialize Instagram handler
const instagramHandler = new InstagramHandler();

// MongoDB connection
mongoose.connect(config.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 5000, // Try to connect for 5 seconds
    socketTimeoutMS: 10000, // Close sockets after 45 seconds of inactivity
})
.then(() => {
    console.log('MongoDB connected successfully');
})
.catch(err => {
    console.error('MongoDB connection error:', err);
});

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
// Handle YouTube downloads
async function downloadYouTubeVideo(url, ctx) {
    let videoPath = null;
    
    try {
        console.log('Starting download process for URL:', url);

        if (!ytdl.validateURL(url)) {
            throw new Error('Invalid YouTube URL');
        }

        const info = await ytdl.getInfo(url);
        console.log(info)
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
                await ctx.editMessageText('⏳ Processing audio...');
                
                // Get highest quality audio
                const format = ytdl.chooseFormat(info.formats, { quality: 'highestaudio' });
                const audioPath = path.join(__dirname, 'downloads', `${videoTitle}.mp3`);
                
                if (!fs.existsSync(path.join(__dirname, 'downloads'))) {
                    fs.mkdirSync(path.join(__dirname, 'downloads'));
                }

                const audioStream = ytdl(url, { format });
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
                console.error('Error:', error);
                await ctx.reply('❌ Failed to process audio');
            }
        });

        // Handle video selection
        bot.action('videoaudio', async (ctx) => {
            try {
                // Get formats with both video and audio
                const formats = ytdl.filterFormats(info.formats, 'videoandaudio');
                
                // Sort formats by quality (highest to lowest)
                const sortedFormats = formats.sort((a, b) => {
                    const aQuality = parseInt(a.qualityLabel);
                    const bQuality = parseInt(b.qualityLabel);
                    return bQuality - aQuality;
                });

                // Create quality options
                const qualityOptions = sortedFormats.map((format, index) => ({
                    text: `📺 ${format.qualityLabel} - ${format.container}`,
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

                            if (!fs.existsSync(path.join(__dirname, 'downloads'))) {
                                fs.mkdirSync(path.join(__dirname, 'downloads'));
                            }

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
                        } catch (error) {
                            console.error('Error:', error);
                            await ctx.reply('❌ Failed to process video');
                        }
                    });
                });
            } catch (error) {
                console.error('Error:', error);
                await ctx.reply('❌ Failed to get video qualities');
            }
        });

    } catch (error) {
        console.error('Error:', error);
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
