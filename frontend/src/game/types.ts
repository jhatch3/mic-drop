export interface PlayerInfo {
  name: string;
  wallet: string;
  score: number | null;
  staked: boolean;
}

export interface RoomState {
  code: string;
  stake: number; // lamports
  state: "waiting" | "staking_complete" | "p1_singing" | "p2_singing" | "finished";
  matchId: string | null;
  winner: string | null;
  players: PlayerInfo[];
}
