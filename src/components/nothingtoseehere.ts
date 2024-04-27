import * as Discord from "discord.js";

import { strict as assert } from "assert";

import { M, ignorable_error } from "../utils/debugging-and-logging.js";
import { colors } from "../common.js";
import { BotComponent } from "../bot-component.js";
import { Wheatley, create_error_reply } from "../wheatley.js";
import { TextBasedCommandBuilder } from "../command-abstractions/text-based-command-builder.js";
import { TextBasedCommand } from "../command-abstractions/text-based-command.js";
import { build_description } from "../utils/strings.js";

/**
 * !nothingtoseehere
 */
export default class Nothingtoseehere extends BotComponent {
    static override get is_freestanding() {
        return true;
    }

    constructor(wheatley: Wheatley) {
        super(wheatley);

        this.add_command(
            new TextBasedCommandBuilder("nothingtoseehere")
                .set_permissions(Discord.PermissionFlagsBits.BanMembers)
                .set_description("Nothing to see here")
                .set_handler(this.nothingtoseehere.bind(this)),
        );
    }

    async nothingtoseehere(command: TextBasedCommand) {
        M.log("Received nothingtoseehere command");
        await command.reply("https://youtu.be/NuAKnbIr6TE");
    }
}
