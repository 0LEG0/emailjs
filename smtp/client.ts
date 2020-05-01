import addressparser from 'addressparser';
import { Message } from './message';
import type { MessageAttachment, MessageHeaders } from './message'; // eslint-disable-line no-unused-vars
import { SMTPConnection, SMTPState } from './smtp';
import type { SMTPConnectionOptions } from './smtp'; // eslint-disable-line no-unused-vars

export interface MessageStack {
	callback: (error: Error | null, message: Message) => void;
	message: Message;
	attachment: MessageAttachment;
	text: string;
	returnPath: string;
	from: string;
	to: ReturnType<typeof addressparser>;
	cc: string[];
	bcc: string[];
}

export class Client {
	public readonly smtp: SMTPConnection;
	public readonly queue: MessageStack[] = [];

	protected sending = false;
	protected ready = false;
	protected timer: NodeJS.Timer | null = null;

	/**
	 * @param {SMTPConnectionOptions} server smtp options
	 */
	constructor(server: Partial<SMTPConnectionOptions>) {
		this.smtp = new SMTPConnection(server);
		//this.smtp.debug(1);
	}

	send(msg: Message, callback: (err: Error, msg: Message) => void) {
		const message: Message | null =
			msg instanceof Message
				? msg
				: this._canMakeMessage(msg)
				? new Message(msg)
				: null;

		if (message == null) {
			callback(new Error('message is not a valid Message instance'), msg);
			return;
		}

		message.valid((valid, why) => {
			if (valid) {
				const stack = {
					message,
					to: addressparser(message.header.to),
					from: addressparser(message.header.from)[0].address,
					callback: (callback || function () {}).bind(this),
				} as MessageStack;

				if (message.header.cc) {
					stack.to = stack.to.concat(addressparser(message.header.cc));
				}

				if (message.header.bcc) {
					stack.to = stack.to.concat(addressparser(message.header.bcc));
				}

				if (
					message.header['return-path'] &&
					addressparser(message.header['return-path']).length
				) {
					stack.returnPath = addressparser(
						message.header['return-path']
					)[0].address;
				}

				this.queue.push(stack);
				this._poll();
			} else {
				callback(new Error(why), msg);
			}
		});
	}

	/**
	 * @private
	 * @returns {void}
	 */
	_poll() {
		if (this.timer != null) {
			clearTimeout(this.timer);
		}

		if (this.queue.length) {
			if (this.smtp.state() == SMTPState.NOTCONNECTED) {
				this._connect(this.queue[0]);
			} else if (
				this.smtp.state() == SMTPState.CONNECTED &&
				!this.sending &&
				this.ready
			) {
				this._sendmail(this.queue.shift() as MessageStack);
			}
		}
		// wait around 1 seconds in case something does come in,
		// otherwise close out SMTP connection if still open
		else if (this.smtp.state() == SMTPState.CONNECTED) {
			this.timer = setTimeout(() => this.smtp.quit(), 1000);
		}
	}

	/**
	 * @private
	 * @param {MessageStack} stack stack
	 * @returns {void}
	 */
	_connect(stack: MessageStack) {
		/**
		 * @param {Error} err callback error
		 * @returns {void}
		 */
		const connect = (err: Error) => {
			if (!err) {
				const begin = (err: Error) => {
					if (!err) {
						this.ready = true;
						this._poll();
					} else {
						stack.callback(err, stack.message);

						// clear out the queue so all callbacks can be called with the same error message
						this.queue.shift();
						this._poll();
					}
				};

				if (!this.smtp.authorized()) {
					this.smtp.login(begin);
				} else {
					this.smtp.ehlo_or_helo_if_needed(begin);
				}
			} else {
				stack.callback(err, stack.message);

				// clear out the queue so all callbacks can be called with the same error message
				this.queue.shift();
				this._poll();
			}
		};

		this.ready = false;
		this.smtp.connect(connect);
	}

	/**
	 * @private
	 * @param {MessageStack} msg message stack
	 * @returns {boolean} can make message
	 */
	_canMakeMessage(msg: MessageHeaders) {
		return (
			msg.from &&
			(msg.to || msg.cc || msg.bcc) &&
			(msg.text !== undefined || this._containsInlinedHtml(msg.attachment))
		);
	}

	/**
	 * @private
	 * @param {*} attachment attachment
	 * @returns {*} whether the attachment contains inlined html
	 */
	_containsInlinedHtml(attachment: MessageAttachment | MessageAttachment[]) {
		if (Array.isArray(attachment)) {
			return attachment.some((att) => {
				return this._isAttachmentInlinedHtml(att);
			});
		} else {
			return this._isAttachmentInlinedHtml(attachment);
		}
	}

	/**
	 * @private
	 * @param {*} attachment attachment
	 * @returns {boolean} whether the attachment is inlined html
	 */
	_isAttachmentInlinedHtml(attachment: MessageAttachment) {
		return (
			attachment &&
			(attachment.data || attachment.path) &&
			attachment.alternative === true
		);
	}

	/**
	 * @private
	 * @param {MessageStack} stack stack
	 * @param {function(MessageStack): void} next next
	 * @returns {function(Error): void} callback
	 */
	_sendsmtp(stack: MessageStack, next: (msg: MessageStack) => void) {
		/**
		 * @param {Error} [err] error
		 * @returns {void}
		 */
		return (err: Error) => {
			if (!err && next) {
				next.apply(this, [stack]);
			} else {
				// if we snag on SMTP commands, call done, passing the error
				// but first reset SMTP state so queue can continue polling
				this.smtp.rset(() => this._senddone(err, stack));
			}
		};
	}

	/**
	 * @private
	 * @param {MessageStack} stack stack
	 * @returns {void}
	 */
	_sendmail(stack: MessageStack) {
		const from = stack.returnPath || stack.from;
		this.sending = true;
		this.smtp.mail(this._sendsmtp(stack, this._sendrcpt), '<' + from + '>');
	}

	/**
	 * @private
	 * @param {MessageStack} stack stack
	 * @returns {void}
	 */
	_sendrcpt(stack: MessageStack) {
		if (stack.to == null || typeof stack.to === 'string') {
			throw new TypeError('stack.to must be array');
		}

		const to = stack.to.shift()!.address;
		this.smtp.rcpt(
			this._sendsmtp(stack, stack.to.length ? this._sendrcpt : this._senddata),
			`<${to}>`
		);
	}

	/**
	 * @private
	 * @param {MessageStack} stack stack
	 * @returns {void}
	 */
	_senddata(stack: MessageStack) {
		this.smtp.data(this._sendsmtp(stack, this._sendmessage));
	}

	/**
	 * @private
	 * @param {MessageStack} stack stack
	 * @returns {void}
	 */
	_sendmessage(stack: MessageStack) {
		const stream = stack.message.stream();

		stream.on('data', (data) => this.smtp.message(data));
		stream.on('end', () => {
			this.smtp.data_end(
				this._sendsmtp(stack, () => this._senddone(null, stack))
			);
		});

		// there is no way to cancel a message while in the DATA portion,
		// so we have to close the socket to prevent a bad email from going out
		stream.on('error', (err) => {
			this.smtp.close();
			this._senddone(err, stack);
		});
	}

	/**
	 * @private
	 * @param {Error} err err
	 * @param {MessageStack} stack stack
	 * @returns {void}
	 */
	_senddone(err: Error | null, stack: MessageStack) {
		this.sending = false;
		stack.callback(err, stack.message);
		this._poll();
	}
}
