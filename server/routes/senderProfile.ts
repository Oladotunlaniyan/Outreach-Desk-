import { Router, type NextFunction, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import { getDatabaseStatus } from '../config/db.ts';
import { requireAuth } from '../middleware/auth.ts';
import { SenderProfile } from '../models/index.ts';
import {
  MAX_WRITING_SAMPLES,
  serializeSenderProfile,
  serializeWritingSample,
  updateSenderProfileSchema,
  updateWritingSampleSchema,
  writingSampleInputSchema,
} from '../utils/senderProfileValidation.ts';

export const senderProfileRouter = Router();

senderProfileRouter.use(requireAuth);

senderProfileRouter.use((_req: Request, res: Response, next: NextFunction) => {
  const db = getDatabaseStatus();
  if (!db.connected) {
    res.status(503).json({
      error: db.lastError || 'MongoDB Atlas is not connected.',
      code: 'DB_UNAVAILABLE',
    });
    return;
  }
  next();
});

senderProfileRouter.get('/', async (_req, res) => {
  try {
    const doc = await SenderProfile.findOne({ profileKey: 'default' }).lean().exec();
    res.json({
      profile: serializeSenderProfile(doc),
    });
  } catch (err) {
    console.error(
      '[Outreach Desk] Failed to load sender profile:',
      err instanceof Error ? err.message : 'Unknown error'
    );
    res.status(500).json({
      error: 'Unable to load sender profile.',
      code: 'SENDER_PROFILE_LOAD_FAILED',
    });
  }
});

async function handleUpsertProfile(req: Request, res: Response): Promise<void> {
  const parsed = updateSenderProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message || 'Invalid sender profile fields.',
      code: 'VALIDATION_ERROR',
      issues: parsed.error.issues,
    });
    return;
  }

  try {
    const updates = parsed.data;
    const doc = await SenderProfile.findOneAndUpdate(
      { profileKey: 'default' },
      {
        $set: {
          ...updates,
          profileKey: 'default',
        },
        $setOnInsert: {
          writingSamples: [],
        },
      },
      {
        new: true,
        upsert: true,
        runValidators: true,
      }
    )
      .lean()
      .exec();

    res.json({
      ok: true,
      profile: serializeSenderProfile(doc),
    });
  } catch (err) {
    console.error(
      '[Outreach Desk] Failed to save sender profile:',
      err instanceof Error ? err.message : 'Unknown error'
    );
    res.status(500).json({
      error: 'Unable to save sender profile.',
      code: 'SENDER_PROFILE_SAVE_FAILED',
    });
  }
}

senderProfileRouter.put('/', (req, res) => void handleUpsertProfile(req, res));
senderProfileRouter.patch('/', (req, res) => void handleUpsertProfile(req, res));

senderProfileRouter.post('/samples', async (req, res) => {
  const parsed = writingSampleInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message || 'Invalid writing sample.',
      code: 'VALIDATION_ERROR',
      issues: parsed.error.issues,
    });
    return;
  }

  try {
    let profile = await SenderProfile.findOne({ profileKey: 'default' }).exec();
    if (!profile) {
      profile = await SenderProfile.create({ profileKey: 'default' });
    }

    if (profile.writingSamples.length >= MAX_WRITING_SAMPLES) {
      res.status(400).json({
        error: `You can store up to ${MAX_WRITING_SAMPLES} writing samples. Delete or edit an existing sample first.`,
        code: 'MAX_SAMPLES_REACHED',
      });
      return;
    }

    const now = new Date();
    profile.writingSamples.push({
      title: parsed.data.title,
      category: parsed.data.category,
      content: parsed.data.content,
      description: parsed.data.description,
      createdAt: now,
      updatedAt: now,
    });

    await profile.save();
    const createdSample = profile.writingSamples[profile.writingSamples.length - 1];

    res.status(201).json({
      ok: true,
      sample: serializeWritingSample(createdSample),
      profile: serializeSenderProfile(profile),
    });
  } catch (err) {
    console.error(
      '[Outreach Desk] Failed to add writing sample:',
      err instanceof Error ? err.message : 'Unknown error'
    );
    res.status(500).json({
      error: 'Unable to add writing sample.',
      code: 'WRITING_SAMPLE_CREATE_FAILED',
    });
  }
});

senderProfileRouter.put('/samples/:sampleId', async (req, res) => {
  const { sampleId } = req.params;
  if (!mongoose.isValidObjectId(sampleId)) {
    res.status(400).json({
      error: 'Invalid writing sample ID.',
      code: 'INVALID_ID',
    });
    return;
  }

  const parsed = updateWritingSampleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message || 'Invalid writing sample update.',
      code: 'VALIDATION_ERROR',
      issues: parsed.error.issues,
    });
    return;
  }

  try {
    const profile = await SenderProfile.findOne({ profileKey: 'default' }).exec();
    if (!profile) {
      res.status(404).json({
        error: 'Writing sample was not found.',
        code: 'SAMPLE_NOT_FOUND',
      });
      return;
    }

    const target = profile.writingSamples.find((s) => String(s._id) === sampleId);
    if (!target) {
      res.status(404).json({
        error: 'Writing sample was not found.',
        code: 'SAMPLE_NOT_FOUND',
      });
      return;
    }

    if (parsed.data.title !== undefined) target.title = parsed.data.title;
    if (parsed.data.category !== undefined) target.category = parsed.data.category;
    if (parsed.data.content !== undefined) target.content = parsed.data.content;
    if (parsed.data.description !== undefined) target.description = parsed.data.description;
    target.updatedAt = new Date();

    await profile.save();

    res.json({
      ok: true,
      sample: serializeWritingSample(target),
      profile: serializeSenderProfile(profile),
    });
  } catch (err) {
    console.error(
      '[Outreach Desk] Failed to update writing sample:',
      err instanceof Error ? err.message : 'Unknown error'
    );
    res.status(500).json({
      error: 'Unable to update writing sample.',
      code: 'WRITING_SAMPLE_UPDATE_FAILED',
    });
  }
});

senderProfileRouter.delete('/samples/:sampleId', async (req, res) => {
  const { sampleId } = req.params;
  if (!mongoose.isValidObjectId(sampleId)) {
    res.status(400).json({
      error: 'Invalid writing sample ID.',
      code: 'INVALID_ID',
    });
    return;
  }

  try {
    const profile = await SenderProfile.findOne({ profileKey: 'default' }).exec();
    if (!profile) {
      res.status(404).json({
        error: 'Writing sample was not found.',
        code: 'SAMPLE_NOT_FOUND',
      });
      return;
    }

    const initialLength = profile.writingSamples.length;
    profile.writingSamples = profile.writingSamples.filter(
      (s) => String(s._id) !== sampleId
    );

    if (profile.writingSamples.length === initialLength) {
      res.status(404).json({
        error: 'Writing sample was not found.',
        code: 'SAMPLE_NOT_FOUND',
      });
      return;
    }

    await profile.save();

    res.json({
      ok: true,
      profile: serializeSenderProfile(profile),
    });
  } catch (err) {
    console.error(
      '[Outreach Desk] Failed to delete writing sample:',
      err instanceof Error ? err.message : 'Unknown error'
    );
    res.status(500).json({
      error: 'Unable to delete writing sample.',
      code: 'WRITING_SAMPLE_DELETE_FAILED',
    });
  }
});
