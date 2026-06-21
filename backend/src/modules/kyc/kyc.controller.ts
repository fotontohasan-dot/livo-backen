import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../../utils/prisma';

const kycSchema = z.object({
  fullName: z.string().min(3, "নাম কমপক্ষে ৩ অক্ষর হতে হবে"),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "সঠিক তারিখ দিন (YYYY-MM-DD)"),
  nationality: z.string().length(2, "দেশের কোড ২ অক্ষর"),
  address: z.string().min(10, "ঠিকানা বিস্তারিত দিন"),
  documentType: z.enum(["passport", "nid", "driving_license"]),
  documentNumber: z.string().min(5, "ডকুমেন্ট নাম্বার সঠিক দিন"),
});

export const submitKyc = async (req: Request, res: Response) => {
  try {
    // TODO: পরে JWT middleware যোগ করবেন
    const userId = "user_temp_id"; // এখন টেস্টের জন্য

    const data = kycSchema.parse(req.body);

    const submission = await prisma.kycSubmission.upsert({
      where: { userId },
      update: {
        ...data,
        status: "SUBMITTED",
      },
      create: {
        userId,
        ...data,
        status: "SUBMITTED",
      },
    });

    res.status(201).json({
      success: true,
      message: "✅ KYC সফলভাবে জমা দেওয়া হয়েছে। অ্যাডমিন রিভিউ করবে।",
      data: submission
    });

  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: error.errors ? error.errors[0].message : error.message
    });
  }
};

export const getKycStatus = async (req: Request, res: Response) => {
  try {
    const userId = "user_temp_id";
    const kyc = await prisma.kycSubmission.findUnique({ where: { userId } });
    
    res.json({
      success: true,
      status: kyc ? kyc.status : "PENDING"
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "সার্ভার সমস্যা" });
  }
};
