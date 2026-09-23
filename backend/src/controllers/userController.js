import jwt from 'jsonwebtoken';
import { User } from '../models/User.js';

const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
};

const tokenResponse = (user) => ({
  user: user.toObject(),
  accessToken: user.generateAccessToken(),
  refreshToken: user.generateRefreshToken(),
  tokenType: 'Bearer',
});

const setAuthCookies = (res, tokens) => {
  res.cookie('accessToken', tokens.accessToken, { ...cookieOptions, maxAge: 15 * 60 * 1000 });
  res.cookie('refreshToken', tokens.refreshToken, { ...cookieOptions, maxAge: 10 * 24 * 60 * 60 * 1000 });
};

const publicUser = (user) => {
  const value = user.toObject();
  delete value.password;
  delete value.refreshToken;
  return value;
};

export const register = async (req, res) => {
  const { username, email, fullnamae, password, phone, coverimage } = req.body;
  if (!username || !email || !fullnamae || !password) {
    throw Object.assign(new Error('username, email, fullnamae, and password are required'), { statusCode: 400 });
  }
  const existingUser = await User.findOne({ $or: [{ username: username.toLowerCase() }, { email: email.toLowerCase() }] });
  if (existingUser) throw Object.assign(new Error('Username or email already exists'), { statusCode: 409 });
  const user = await User.create({ username, email, fullnamae, password, phone, coverimage });
  const tokens = tokenResponse(user);
  user.refreshToken = tokens.refreshToken;
  await user.save({ validateBeforeSave: false });
  setAuthCookies(res, tokens);
  res.status(201).json({ data: { ...tokens, user: publicUser(user) } });
};

export const login = async (req, res) => {
  const { email, username, password } = req.body;
  if ((!email && !username) || !password) throw Object.assign(new Error('Email or username and password are required'), { statusCode: 400 });
  const user = await User.findOne({ [email ? 'email' : 'username']: (email || username).toLowerCase() }).select('+password +refreshToken');
  if (!user || !(await user.isPasswordCorrect(password))) throw Object.assign(new Error('Invalid credentials'), { statusCode: 401 });
  const tokens = tokenResponse(user);
  user.refreshToken = tokens.refreshToken;
  await user.save({ validateBeforeSave: false });
  setAuthCookies(res, tokens);
  res.json({ data: { ...tokens, user: publicUser(user) } });
};

export const logout = async (req, res) => {
  await User.updateOne({ _id: req.user._id }, { $unset: { refreshToken: 1 } });
  res.clearCookie('accessToken', cookieOptions);
  res.clearCookie('refreshToken', cookieOptions);
  res.json({ data: { message: 'Logged out successfully' } });
};

export const refreshToken = async (req, res) => {
  const incomingToken = req.cookies?.refreshToken || req.body.refreshToken;
  if (!incomingToken) throw Object.assign(new Error('Refresh token is required'), { statusCode: 401 });
  const decoded = jwt.verify(incomingToken, process.env.REFRESH_TOKEN_SECRET);
  const user = await User.findById(decoded._id).select('+refreshToken');
  if (!user || user.refreshToken !== incomingToken) throw Object.assign(new Error('Invalid refresh token'), { statusCode: 401 });
  const tokens = tokenResponse(user);
  user.refreshToken = tokens.refreshToken;
  await user.save({ validateBeforeSave: false });
  setAuthCookies(res, tokens);
  res.json({ data: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, tokenType: 'Bearer' } });
};

export const accessToken = async (req, res) => {
  res.json({ data: { accessToken: req.user.generateAccessToken(), tokenType: 'Bearer' } });
};