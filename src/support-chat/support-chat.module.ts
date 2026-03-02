import { Module } from '@nestjs/common';
import { SupportChatController } from './support-chat.controller';
import { SupportChatService } from './support-chat.service';
import { SupportChatContextService } from './support-chat-context.service';
import { SupportChatPlaybookService } from './support-chat-playbook.service';
import { SupportChatComposerService } from './support-chat-composer.service';
import { SupportChatReasonerService } from './support-chat-reasoner.service';

@Module({
  controllers: [SupportChatController],
  providers: [
    SupportChatService,
    SupportChatContextService,
    SupportChatPlaybookService,
    SupportChatComposerService,
    SupportChatReasonerService,
  ],
  exports: [
    SupportChatService,
    SupportChatContextService,
    SupportChatPlaybookService,
    SupportChatComposerService,
    SupportChatReasonerService,
  ],
})
export class SupportChatModule {}
