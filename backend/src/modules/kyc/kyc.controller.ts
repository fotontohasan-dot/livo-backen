import { Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import prisma from '../../utils/prisma';

const upload = multer({ storage: multer.memoryStorage() });

const kycSchema = z.object({
  fullName: z.string().min(3),
  dateOfBirth: z.string(),
  nationality: z.string().length(2),
  address: z.string().min(10),
  documentType: z.enum(['nid', 'passport', 'driving_license']),
  documentNumber: z.string().min(5),
});

export const submitKyc = async (req: Request, res: Response) => {
  try {
    const userId = "temp-user-id"; // পরে JWT যোগ হবে

    const data = kycSchema.parse(req.body);

    const submission = await prisma.kycSubmission.upsert({
      where: { userId },
      update: { ...data, status: 'SUBMITTED' },
      create: { userId, ...data, status: 'SUBMITTED' }
    });

    res.status(201).json({ 
      success: true, 
      message: "KYC সফলভাবে জমা দেওয়া হয়েছে। অ্যাডমিন রিভিউ করবে।" 
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export { upload };
export const getKycStatus = async (req: Request, res: Response) => {
  try {
    const userId = "temp-user-id";
    const kyc = await prisma.kycSubmission.findUnique({ where: { userId } });
    res.json({ success: true, status: kyc?.status || "PENDING" });
  } catch (error) {
    res.status(500).json({ success: false, message: "সার্ভার এরর" });
  }
};
