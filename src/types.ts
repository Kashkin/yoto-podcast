// --- Config types ---

export interface PodcastConfig {
  name: string;
  feedUrl: string;
  directory: string;
  cardId: string;
  skipPatterns?: string[];
}

export interface AppConfig {
  podcasts: PodcastConfig[];
  yoto: {
    clientId: string;
  };
}

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp in ms
}

// --- Feed types ---

export interface FeedEpisode {
  title: string;
  url: string;
  index: number; // 1-based position in feed (1 = newest)
}

// --- Yoto card content types (not typed by SDK) ---

export interface YotoTrack {
  key: string;
  title: string;
  trackUrl: string;
  format: string;
  type: string;
  channels?: string;
  duration?: number;
  fileSize?: number;
  display?: { icon16x16?: string };
  overlayLabel?: string;
}

export interface YotoChapter {
  key: string;
  title: string;
  tracks: YotoTrack[];
  duration?: number;
  fileSize?: number;
  display?: { icon16x16?: string };
  overlayLabel?: string;
}

export interface YotoCardContent {
  activity?: string;
  chapters: YotoChapter[];
  config?: {
    autoadvance?: string;
    resumeTimeout?: number;
  };
  editTracksEnabled?: boolean;
  playbackType?: string;
  version?: string;
}

export interface YotoCardMetadata {
  author?: string;
  category?: string;
  description?: string;
  cover?: { imageL?: string };
  media?: { duration?: number; fileSize?: number };
}

export interface YotoCard {
  cardId?: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
  content: YotoCardContent;
  metadata?: YotoCardMetadata;
}
