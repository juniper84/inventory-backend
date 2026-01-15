-- DropForeignKey
ALTER TABLE "NoteLink" DROP CONSTRAINT "NoteLink_noteId_fkey";

-- DropForeignKey
ALTER TABLE "NoteReminder" DROP CONSTRAINT "NoteReminder_noteId_fkey";

-- AddForeignKey
ALTER TABLE "NoteLink" ADD CONSTRAINT "NoteLink_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "Note"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteReminder" ADD CONSTRAINT "NoteReminder_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "Note"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
