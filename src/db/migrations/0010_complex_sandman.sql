ALTER TABLE `groups` ADD `total_wins` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `groups` ADD `pending_wins` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `groups` SET
  `total_wins` = (
    SELECT count(*) FROM `wins`
    INNER JOIN `giveaways` ON `giveaways`.`id` = `wins`.`giveaway_id`
    WHERE `giveaways`.`group_id` = `groups`.`id`
  ),
  `pending_wins` = (
    SELECT count(*) FROM `wins`
    INNER JOIN `giveaways` ON `giveaways`.`id` = `wins`.`giveaway_id`
    WHERE `giveaways`.`group_id` = `groups`.`id` AND `wins`.`status` = 'pending'
  );