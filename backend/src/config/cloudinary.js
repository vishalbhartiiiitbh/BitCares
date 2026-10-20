import { v2 as cloudinary } from 'cloudinary';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export const uploadImageBuffer = (buffer, folder = 'splitcare/profiles') =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({ folder, resource_type: 'image' }, (error, result) => {
      if (error) return reject(error);
      resolve(result.secure_url);
    });
    stream.end(buffer);
  });

export const deleteImageByUrl = async (imageUrl) => {
  const cloudName = cloudinary.config().cloud_name;
  if (!cloudName) throw new Error('Cloudinary cloud name is not configured');

  // Only delete assets hosted by this configured account; unrelated URLs are left untouched.
  const url = new URL(imageUrl);
  if (url.hostname !== `${cloudName}.res.cloudinary.com`) return false;

  const pathSegments = url.pathname.split('/').filter(Boolean);
  const uploadIndex = pathSegments.indexOf('upload');
  const versionIndex = pathSegments.findIndex((segment, index) => index > uploadIndex && /^v\d+$/.test(segment));
  if (uploadIndex === -1 || versionIndex === -1 || versionIndex === pathSegments.length - 1) return false;

  const publicIdSegments = pathSegments.slice(versionIndex + 1);
  publicIdSegments[publicIdSegments.length - 1] = publicIdSegments.at(-1).replace(/\.[^.]+$/, '');
  const result = await cloudinary.uploader.destroy(publicIdSegments.join('/'), { resource_type: 'image' });
  if (!['ok', 'not found'].includes(result.result)) {
    throw new Error(`Cloudinary image deletion failed: ${result.result}`);
  }
  return true;
};

export default cloudinary;
