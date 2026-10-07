/*
  Warnings:

  - Added the required column `age` to the `order_sessions` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "order_sessions" ADD COLUMN     "age" INTEGER NOT NULL;
