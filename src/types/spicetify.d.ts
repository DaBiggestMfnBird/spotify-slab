interface SlabEqualizerFilter {
    frequency: number;
    key: string;
    type: "lowshelf" | "peaking" | "highshelf";
    gain: number;
}

interface SlabPlayerRestrictions {
    disallowSettingPlaybackSpeedReasons?: string[];
}

interface SlabPlayerItem {
    uri: string;
    name?: string;
    metadata?: Record<string, string>;
    duration?: { milliseconds: number };
}

interface SlabPlayerState {
    item?: SlabPlayerItem;
    context?: { uri?: string };
    isPaused: boolean;
    speed?: number;
    positionAsOfTimestamp?: number;
    duration?: number;
    restrictions?: SlabPlayerRestrictions;
}

interface SlabPlayerCapabilities {
    canChangeSpeed?: boolean;
    canChangeVolume?: boolean;
}

interface SlabAudioAnalysis {
    track?: {
        tempo?: number;
        time_signature?: number;
        duration?: number;
    };
    beats?: { start: number; duration: number; confidence?: number }[];
    bars?: { start: number; duration: number; confidence?: number }[];
    sections?: { start: number; duration: number }[];
}

interface SlabSpicetify {
    Player: {
        data: {
            item?: SlabPlayerItem;
            context?: { uri?: string };
        } | null;
        getProgress(): number;
        getDuration(): number;
        isPlaying(): boolean;
        seek(ms: number): void;
        pause(): void;
        play(): void;
        getVolume(): number;
        setVolume(volume: number): void;
        addEventListener(event: string, callback: (payload?: unknown) => void): void;
        removeEventListener(event: string, callback: (payload?: unknown) => void): void;
    };
    Platform: {
        ConnectAPI?: {
            state?: { activeDevice?: { name?: string; isLocal?: boolean } };
        };
        PlayerAPI: {
            getState(): SlabPlayerState;
            getCapabilities?(): SlabPlayerCapabilities | undefined;
            setSpeed?(speed: number): Promise<unknown>;
        };
        EqualizerAPI?: {
            getFilters(): Promise<SlabEqualizerFilter[]>;
            setFilterGain(key: string, gain: number): Promise<void>;
            setEnabledState(enabled: boolean): void;
            isSupported?(): boolean;
        };
    };
    getAudioData(uri?: string): Promise<SlabAudioAnalysis>;
    showNotification?(message: string, isError?: boolean, timeout?: number): void;
    /** The client's own authenticated requests, for its lyrics among other things. */
    CosmosAsync?: {
        get(url: string, body?: unknown, headers?: Record<string, string>): Promise<unknown>;
    };
}

declare const Spicetify: SlabSpicetify;

declare interface Window {
    SLAB?: unknown;
    __slabClaim?: unknown;
    ModernEQ?: unknown;
}
