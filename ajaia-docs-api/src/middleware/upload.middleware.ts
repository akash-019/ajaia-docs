import multer from 'multer';
import { MAX_UPLOAD_BYTES } from '../services/import.service.js';

/** One file in the "file" field, kept in memory (imports are small and converted immediately). */
export const uploadSingleFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
}).single('file');
