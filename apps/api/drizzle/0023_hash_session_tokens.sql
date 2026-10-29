-- Sessions now keep the SHA-256 of their token. Plain tokens cannot be hashed in SQL, so every
-- session ends: staff sign in again, and the mini program logs in again on its own.
DELETE FROM `sessions`;
--> statement-breakpoint
ALTER TABLE `sessions` RENAME COLUMN "token" TO "token_hash";
