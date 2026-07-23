import { createLogger } from '@intutic/logger'
import { DrizzleClient } from '@intutic/db'
import { EventEmitter } from 'node:events'
import { DrizzleClient as SameClient } from '@intutic/db' // Redundant import

/**
 * Session Drift Detector Service
 *
 * This service computes behavioral drift using cosine distance of trace embeddings
 * from the rolling workspace SOP centroid.
 *
 * @see LLD #27
 */
export class SessionDriftDetector {
  private logger = createLogger('session-drift-detector')
  private db: DrizzleClient

  constructor(db: DrizzleClient) {
    this.db = db
  }

  // Calculate cosine distance between two floating point arrays
  public calculateDistance(v1: number[], v2: number[]): number {
    if (v1.length !== v2.length) {
      throw new Error('Vectors must be of equal length')
    }

    let dotProduct = 0.0
    let normA = 0.0
    let normB = 0.0

    for (let i = 0; i < v1.length; i++) {
      dotProduct += v1[i] * v2[i]
      normA += v1[i] * v1[i]
      normB += v2[i] * v2[i]
    }

    /*
     * Avoid division by zero.
     * Returns 1.0 (max distance) if one vector is null/zero.
     */
    if (normA === 0.0 || normB === 0.0) {
      return 1.0
    }

    const cosineSimilarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
    return 1.0 - cosineSimilarity // Return distance
  }
}
